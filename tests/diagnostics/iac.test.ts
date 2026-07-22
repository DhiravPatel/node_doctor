import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runTextScan } from "../../src/core/text-scan.ts";
import { IAC_DIAGNOSTICS } from "../../src/diagnostics/iac/index.ts";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run the IaC diagnostics over a single fabricated file. */
const scan = async (name: string, content: string): Promise<string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-iac-"));
  try {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
    const findings = await runTextScan(dir, { textDiagnostics: IAC_DIAGNOSTICS });
    return findings.map((f) => f.diagnostic);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("no-open-security-group", () => {
  test("fires on ingress open to the world on a non-web port", async () => {
    const tf = `resource "aws_security_group" "db" {\n  ingress {\n    from_port = 5432\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n`;
    assert.deepEqual(await scan("main.tf", tf), ["no-open-security-group"]);
  });

  test("SILENT on egress to the world — that is the normal default", async () => {
    const tf = `resource "aws_security_group" "a" {\n  egress {\n    from_port = 0\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n`;
    assert.deepEqual(await scan("main.tf", tf), []);
  });

  test("SILENT on a public web port (80/443) — defensible intent", async () => {
    const tf = `resource "aws_security_group" "web" {\n  ingress {\n    from_port = 443\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n`;
    assert.deepEqual(await scan("main.tf", tf), []);
  });

  test("SILENT on a restricted CIDR", async () => {
    const tf = `resource "aws_security_group" "db" {\n  ingress {\n    from_port = 5432\n    cidr_blocks = ["10.0.0.0/16"]\n  }\n}\n`;
    assert.deepEqual(await scan("main.tf", tf), []);
  });

  test("SILENT when commented out", async () => {
    const tf = `resource "aws_security_group" "db" {\n  ingress {\n    from_port = 5432\n    # cidr_blocks = ["0.0.0.0/0"]\n  }\n}\n`;
    assert.deepEqual(await scan("main.tf", tf), []);
  });
});

describe("no-public-cloud-storage", () => {
  test("fires on a public-read ACL", async () => {
    assert.deepEqual(await scan("s3.tf", `resource "aws_s3_bucket" "b" {\n  acl = "public-read"\n}\n`), ["no-public-cloud-storage"]);
  });
  test("fires when a public-access block is disabled", async () => {
    assert.deepEqual(
      await scan("s3.tf", `resource "aws_s3_bucket_public_access_block" "b" {\n  block_public_acls = false\n}\n`),
      ["no-public-cloud-storage"],
    );
  });
  test("SILENT on a private ACL and enabled blocks", async () => {
    assert.deepEqual(
      await scan("s3.tf", `resource "aws_s3_bucket" "b" {\n  acl = "private"\n  block_public_acls = true\n}\n`),
      [],
    );
  });
});

describe("no-overbroad-iam-policy", () => {
  test("fires only when BOTH action and resource are wildcards", async () => {
    const json = JSON.stringify({
      Resources: { P: { Type: "AWS::IAM::Policy" } },
      Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
    }, null, 2);
    assert.deepEqual(await scan("policy.json", json), ["no-overbroad-iam-policy"]);
  });

  test("SILENT on a wildcard resource with a scoped action", async () => {
    const json = JSON.stringify({
      Resources: { P: { Type: "AWS::IAM::Policy" } },
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
    }, null, 2);
    assert.deepEqual(await scan("policy.json", json), []);
  });

  test("SILENT on a wildcard action scoped to one resource ARN", async () => {
    const json = JSON.stringify({
      Resources: { P: { Type: "AWS::IAM::Policy" } },
      Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::my-bucket/*" }],
    }, null, 2);
    assert.deepEqual(await scan("policy.json", json), []);
  });

  test("fires on the Terraform policy-document form", async () => {
    const tf = `data "aws_iam_policy_document" "d" {\n  statement {\n    actions   = ["*"]\n    resources = ["*"]\n  }\n}\n`;
    assert.deepEqual(await scan("iam.tf", tf), ["no-overbroad-iam-policy"]);
  });
});

describe("the IaC gate keeps these off ordinary config", () => {
  test("SILENT on docker-compose (not IaC)", async () => {
    const yml = `services:\n  web:\n    image: nginx\n    environment:\n      ACL: public-read\n`;
    assert.deepEqual(await scan("docker-compose.yml", yml), []);
  });
  test("SILENT on a GitHub workflow (not IaC)", async () => {
    const yml = `name: ci\njobs:\n  build:\n    steps:\n      - run: echo "0.0.0.0/0"\n`;
    assert.deepEqual(await scan(".github/workflows/ci.yml", yml), []);
  });
  test("SILENT on tsconfig.json (not IaC)", async () => {
    assert.deepEqual(await scan("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } })), []);
  });
  test("a CloudFormation template IS gated in", async () => {
    const yml = `AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties:\n      AccessControl: PublicRead\n`;
    assert.deepEqual(await scan("template.yml", yml), ["no-public-cloud-storage"]);
  });
});
