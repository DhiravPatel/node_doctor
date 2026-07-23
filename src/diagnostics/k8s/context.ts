/**
 * Shared manifest parsing for the Kubernetes diagnostics.
 *
 * The hard part of a K8s lint is not the rule — it is proving that a `.yaml`
 * file *is* a Kubernetes manifest. A real repo's YAML is mostly GitHub Actions
 * workflows, docker-compose, OpenAPI specs, i18n bundles and Helm values, and
 * several of them use exactly the words these rules look for: docker-compose
 * has `privileged: true`, a workflow has `container:`. So every rule goes
 * through `kubernetesDocuments`, which yields a document only when it declares
 * both `apiVersion:` and a workload `kind:` at the document root.
 *
 * Helm templates are skipped outright: `{{ .Values.x }}` is not YAML, the
 * indentation is generated, and anything inferred from it is a guess.
 *
 * The parser is a deliberately small, tolerant line model — no YAML dependency
 * exists in this project and none is being added. It understands mappings,
 * block sequences and block scalars, which is the whole of a workload manifest;
 * anything it cannot resolve (flow maps, anchors, aliases) is left unresolved so
 * the caller can stay silent rather than guess.
 */

import { stripComment } from "../iac/context.ts";

/** One node of a parsed manifest: a mapping entry, or a sequence item. */
export interface ManifestNode {
  /** Mapping key, or `null` for a sequence item. */
  key: string | null;
  /** The inline scalar/flow value after the colon; "" when the value is a nested block. */
  value: string;
  /** 0-based line index within the whole file. */
  line: number;
  /** 1-based column of the key (or of the `-` for a sequence item). */
  column: number;
  indent: number;
  /** Is this node a sequence item (`- …`)? */
  item: boolean;
  children: ManifestNode[];
}

/** A single YAML document that is a Kubernetes workload. */
export interface ManifestDocument {
  /** Synthetic root; its children are the document's top-level keys. */
  root: ManifestNode;
  /** The `kind:` value, already validated against the workload set. */
  kind: string;
}

/**
 * Only these kinds embed a pod spec. Restricting to them is what keeps a
 * ConfigMap that happens to carry a docker-compose blob, or a CRD with a
 * free-form `spec`, out of these rules.
 */
const WORKLOAD_KINDS = new Set([
  "CronJob",
  "DaemonSet",
  "Deployment",
  "Job",
  "Pod",
  "ReplicaSet",
  "ReplicationController",
  "StatefulSet",
]);

/** Keys whose sequence items are container specs. */
export const CONTAINER_KEYS: ReadonlySet<string> = new Set(["containers", "initContainers", "ephemeralContainers"]);

/** Go-template delimiters: a Helm chart template, not parseable YAML. */
const HELM_TEMPLATE_RE = /\{\{/;
const DOCUMENT_START_RE = /^---(\s.*)?$/;
const DOCUMENT_END_RE = /^\.\.\.\s*$/;
/** `|`, `>`, `|-`, `>2+` … — everything more indented below belongs to the scalar. */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*[-+]?$/;
/** `key: value`, `"quoted key": value`, `key:` — YAML requires the space after the colon. */
const KEY_VALUE_RE = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#][^:]*?))\s*:(?:\s+(.*))?$/;

/** Strip one layer of surrounding quotes from a scalar. */
export const unquote = (value: string): string => value.trim().replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1");

/**
 * A boolean that is unambiguously true. YAML 1.1's `yes`/`on` are deliberately
 * not accepted: they are rare in manifests and the cost of a wrong guess here is
 * a false "your container is privileged".
 */
export const isTrue = (value: string): boolean => /^(?:true|True|TRUE)$/.test(value.trim());

const leadingWidth = (line: string): number => line.length - line.trimStart().length;

const parseKeyValue = (text: string): { key: string; value: string } | null => {
  const match = KEY_VALUE_RE.exec(text);
  if (!match) return null;
  return { key: match[1] ?? match[2] ?? match[3] ?? "", value: (match[4] ?? "").trim() };
};

/**
 * Parse one document's line range into a tree.
 *
 * Nesting is resolved by indentation, with the one YAML quirk that matters here:
 * a block sequence may sit at the *same* indent as the key that owns it
 * (`containers:` / `- name: app` both at column 0), so a sequence item pops only
 * deeper nodes and sibling items, never its owning key.
 */
const parseDocument = (lines: string[], from: number, to: number): ManifestNode => {
  const root: ManifestNode = { key: null, value: "", line: from, column: 1, indent: -1, item: false, children: [] };
  const stack: ManifestNode[] = [root];
  let blockScalarIndent = -1;

  for (let i = from; i < to; i++) {
    const raw = (lines[i] ?? "").replace(/\r$/, "");

    // Inside a block scalar every line is opaque text — a `privileged: true`
    // in an embedded compose file or shell script must not be read as YAML.
    if (blockScalarIndent >= 0) {
      if (raw.trim().length === 0) continue;
      if (leadingWidth(raw) > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }

    const line = stripComment(raw).replace(/\s+$/, "");
    if (line.trim().length === 0) continue;

    const indent = leadingWidth(line);
    const rest = line.slice(indent);
    let node: ManifestNode;

    if (/^-(\s|$)/.test(rest)) {
      while (stack.length > 1) {
        const top = stack[stack.length - 1]!;
        if (top.indent > indent || (top.item && top.indent >= indent)) stack.pop();
        else break;
      }
      const item: ManifestNode = {
        key: null,
        value: "",
        line: i,
        column: indent + 1,
        indent,
        item: true,
        children: [],
      };
      stack[stack.length - 1]!.children.push(item);
      stack.push(item);

      const after = rest.slice(1);
      const content = after.trimStart();
      if (content.length === 0) continue;
      const contentIndent = indent + 1 + (after.length - content.length);
      const entry = parseKeyValue(content);
      if (!entry) {
        // A scalar item: `- SYS_ADMIN`.
        item.value = content;
        // …or a block scalar opened by a bare sequence item (`- |`), which is
        // exactly the `command: [/bin/sh, -c, |]` shape. Everything indented
        // past it is opaque shell text, and a `kubectl apply` heredoc in there
        // routinely contains a second manifest — parsing that as structure made
        // the embedded pod's `privileged: true` a finding against the outer file.
        // The parent for indentation purposes is the sequence item itself, not
        // the column of the `|` indicator: content sits one level in from the
        // dash, which is less than the indicator column.
        if (BLOCK_SCALAR_RE.test(content)) blockScalarIndent = indent;
        continue;
      }
      node = {
        key: entry.key,
        value: entry.value,
        line: i,
        column: contentIndent + 1,
        indent: contentIndent,
        item: false,
        children: [],
      };
      item.children.push(node);
      stack.push(node);
    } else {
      const entry = parseKeyValue(rest);
      // Continuations, multi-line flow collections and plain scalars are not
      // structure; ignoring them leaves the stack untouched, which is correct.
      if (!entry) continue;
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      node = {
        key: entry.key,
        value: entry.value,
        line: i,
        column: indent + 1,
        indent,
        item: false,
        children: [],
      };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
    }

    if (BLOCK_SCALAR_RE.test(node.value)) blockScalarIndent = node.indent;
  }

  return root;
};

/** The first direct child with this mapping key. */
export const childByKey = (node: ManifestNode, key: string): ManifestNode | undefined =>
  node.children.find((child) => child.key === key);

/** Depth-first over every node below `root`, in document order. */
export const walkNodes = (
  root: ManifestNode,
  visit: (node: ManifestNode, parent: ManifestNode) => void,
): void => {
  const recurse = (node: ManifestNode, parent: ManifestNode): void => {
    visit(node, parent);
    for (const child of node.children) recurse(child, node);
  };
  for (const child of root.children) recurse(child, root);
};

/** Every container spec in the document, in line order. */
export const containerItems = (root: ManifestNode, keys: ReadonlySet<string> = CONTAINER_KEYS): ManifestNode[] => {
  const found: ManifestNode[] = [];
  walkNodes(root, (node) => {
    if (node.key !== null && keys.has(node.key)) {
      for (const child of node.children) if (child.item) found.push(child);
    }
  });
  return found;
};

/** `name:` of the container a node belongs to, for a message that points at something. */
export const containerNames = (root: ManifestNode): Map<ManifestNode, string> => {
  const names = new Map<ManifestNode, string>();
  for (const container of containerItems(root)) {
    const name = unquote(childByKey(container, "name")?.value ?? "");
    const pending: ManifestNode[] = [container];
    while (pending.length > 0) {
      const node = pending.pop()!;
      names.set(node, name);
      for (const child of node.children) pending.push(child);
    }
  }
  return names;
};

const workloadKind = (root: ManifestNode): string | null => {
  const apiVersion = childByKey(root, "apiVersion");
  if (!apiVersion || unquote(apiVersion.value).length === 0) return null;
  const kind = childByKey(root, "kind");
  if (!kind) return null;
  const value = unquote(kind.value);
  return WORKLOAD_KINDS.has(value) ? value : null;
};

/**
 * Every workload document in the file. Multi-document files are the norm — a
 * Service plus a Deployment in one `k8s.yaml` — so each `---` section is judged
 * on its own evidence; a Service simply yields nothing.
 */
export const kubernetesDocuments = (content: string): ManifestDocument[] => {
  if (HELM_TEMPLATE_RE.test(content)) return [];
  // Cheap reject before splitting: no manifest lacks these two keys.
  if (!/^apiVersion\s*:/m.test(content) || !/^kind\s*:/m.test(content)) return [];

  const lines = content.split("\n");
  const documents: ManifestDocument[] = [];
  let start = 0;

  const flush = (end: number): void => {
    if (end <= start) return;
    const root = parseDocument(lines, start, end);
    const kind = workloadKind(root);
    if (kind) documents.push({ root, kind });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").replace(/\r$/, "");
    if (DOCUMENT_START_RE.test(raw) || DOCUMENT_END_RE.test(raw)) {
      flush(i);
      start = i + 1;
    }
  }
  flush(lines.length);
  return documents;
};
