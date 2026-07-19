/**
 * SARIF 2.1.0 reporter for GitHub code-scanning upload.
 *
 * Diagnostic descriptors are built from the findings actually produced (so the
 * document is self-contained), and each result carries a `partialFingerprints`
 * entry with our stable finding id for cross-run correlation.
 */

import type { Finding } from "../core/types.ts";
import type { ScanReport } from "../core/scan.ts";

const sarifLevel = (severity: string): "error" | "warning" =>
  severity === "error" ? "error" : "warning";

export interface SarifOptions {
  version?: string;
}

interface SarifRuleDescriptor {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: "error" | "warning" };
  properties: { category: string; tags: string[] };
}

/** Build a SARIF 2.1.0 document from a scan report. */
export const toSarif = (report: ScanReport, options: SarifOptions = {}): string => {
  const ruleDescriptors = new Map<string, SarifRuleDescriptor>();

  for (const d of report.findings) {
    if (!ruleDescriptors.has(d.diagnostic)) {
      ruleDescriptors.set(d.diagnostic, {
        id: d.diagnostic,
        name: d.diagnostic,
        shortDescription: { text: d.title },
        fullDescription: { text: d.recommendation },
        defaultConfiguration: { level: sarifLevel(d.severity) },
        properties: { category: d.category, tags: d.tags },
      });
    }
  }

  const results = report.findings.map((d: Finding) => ({
    ruleId: d.diagnostic,
    level: sarifLevel(d.severity),
    message: { text: d.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: d.normalizedFilePath },
          region: { startLine: d.line, startColumn: d.column },
        },
      },
    ],
    partialFingerprints: { nodeDoctorDiagnosticId: d.id },
    properties: { recommendation: d.recommendation, category: d.category },
  }));

  const doc = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "node-doctor",
            informationUri: "https://github.com/your-org/node-doctor",
            version: options.version ?? "0.0.0",
            rules: [...ruleDescriptors.values()],
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(doc, null, 2);
};
