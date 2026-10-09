// The shared reading of infrastructure files for trivy, checkov and tflint
// (iac.ts): where a finding is anchored in its file, and which Terraform
// folders may be handed to which scanner. Cases are the shapes the real
// binaries report (trivy 0.75.0, checkov 3.3.22), on the files they ran on.
//
// Failure list, written before the code:
//   1. A checkov finding on a Terraform resource keeps the resource's whole
//      span, so a change to an unrelated attribute of a resource that already
//      has the finding reports it again; or a change to the offending
//      attribute does not report it. Its evaluated keys
//      (`ingress/[0]/cidr_blocks`) name an attribute of the n-th repeated
//      block, an attribute whose value spans lines (a list, a heredoc), or a
//      path inside an attribute's object value.
//   2. The same in YAML: a Kubernetes object
//      (`spec/template/spec/containers/[0]/securityContext/privileged`), a
//      sequence under a key at the key's own indentation, a flow collection,
//      a quoted key, a document after `---`, a CloudFormation resource under
//      Resources.
//   3. A key that names an attribute the resource lacks widens the span; when
//      no key names one that exists, the finding is not anchored to the first
//      line of the deepest block on a key's path that exists, or with no key
//      at all to the resource's first line.
//   4. A trivy cause that is a whole block (an HCL block, a YAML mapping, a
//      sequence item that is a mapping) is not anchored to the block's first
//      line; or a cause that is one attribute over several lines (a list) is.
//   5. A brace, an `=` or a line end in a string, a heredoc or a comment
//      breaks the structure that is read.
//   6. A Terraform folder that names a module from outside the repository
//      (the registry, git, https, an expression) is handed to trivy, which
//      would download it; a folder with `./` and `../` modules only is held
//      back. A folder whose module source leaves the repository (`../` past
//      its root, an absolute path, an expression) is handed to checkov, which
//      would read it from disk. `.tf.json` modules count the same.
//   7. A hostile file (deep braces, blocks left open, many heredoc words,
//      deep indentation) makes the reading take more than linear time.
import { describe, expect, it } from "vitest";
import { anchorFinding, blockCause, moduleSources, moduleVerdict } from "./iac.js";

const tf = (...rows: string[]): string => `${rows.join("\n")}\n`;

const SG = tf(
  'resource "aws_security_group" "web" {', // 1
  '  name        = "web"', // 2
  '  description = "web access { not a brace"', // 3
  "", // 4
  "  ingress {", // 5
  '    description = "ssh"', // 6
  "    from_port   = 22", // 7
  "    to_port     = 22", // 8
  '    protocol    = "tcp"', // 9
  '    cidr_blocks = ["0.0.0.0/0"]', // 10
  "  }", // 11
  "", // 12
  "  ingress {", // 13
  "    from_port   = 443", // 14
  "    to_port     = 443", // 15
  '    protocol    = "tcp"', // 16
  "    cidr_blocks = [", // 17
  '      "10.0.0.0/8",', // 18
  "    ]", // 19
  "  }", // 20
  "", // 21
  "  tags = {", // 22
  '    Name = "web"', // 23
  "  }", // 24
  "}", // 25
  "", // 26
  'resource "aws_s3_bucket" "logs" {', // 27
  '  bucket = "logs"', // 28
  "  policy = <<-EOT", // 29
  "    { \"Statement\": [ }", // 30
  "    EOT", // 31
  "}", // 32
);

describe("checkov findings are anchored to the attributes they name (1, 3, 5)", () => {
  it("maps evaluated keys to the attribute lines of the n-th repeated block", () => {
    const keys = ["ingress/[0]/from_port", "ingress/[0]/to_port", "ingress/[0]/cidr_blocks", "ingress/[0]/ipv6_cidr_blocks"];
    expect(anchorFinding(SG, "main.tf", 1, 25, keys)).toEqual([7, 10]);
    expect(anchorFinding(SG, "main.tf", 1, 25, ["ingress/[1]/cidr_blocks"])).toEqual([17, 19]);
  });

  it("maps a path inside an object value to the attribute, and a heredoc value to all its lines", () => {
    expect(anchorFinding(SG, "main.tf", 1, 25, ["tags/Name"])).toEqual([22, 24]);
    expect(anchorFinding(SG, "main.tf", 27, 32, ["policy"])).toEqual([29, 31]);
  });

  it("anchors a finding whose keys name nothing that exists to the deepest block that does, then to the resource's first line", () => {
    expect(anchorFinding(SG, "main.tf", 1, 25, ["ingress/[1]/description"])).toEqual([13, 13]);
    expect(anchorFinding(SG, "main.tf", 27, 32, ["logging", "resource_type"])).toEqual([27, 27]);
    expect(anchorFinding(SG, "main.tf", 27, 32, [])).toEqual([27, 27]);
  });
});

const DEPLOY = tf(
  "# the web tier", // 1
  "---", // 2
  "apiVersion: apps/v1", // 3
  "kind: Deployment", // 4
  "metadata:", // 5
  "  name: web", // 6
  '  annotations: {"a": "b"}', // 7
  "spec:", // 8
  "  template:", // 9
  "    spec:", // 10
  "      containers:", // 11
  "      - name: web", // 12
  '        image: "nginx:1.27 # not a comment"', // 13
  "        args:", // 14
  "          - --port", // 15
  '          - "8080"', // 16
  "        securityContext:", // 17
  "          privileged: true", // 18
  '          "readOnlyRootFilesystem": false', // 19
  "      - name: side", // 20
  "        image: busybox", // 21
  "---", // 22
  "apiVersion: v1", // 23
  "kind: Service", // 24
  "metadata:", // 25
  "  name: web", // 26
);

describe("checkov findings in YAML are anchored to the keys they name (2, 3)", () => {
  it("maps a key path through a sequence under a key at the key's own indentation", () => {
    const key = "spec/template/spec/containers/[0]/securityContext/privileged";
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, [key])).toEqual([18, 18]);
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, ["spec/template/spec/containers/[0]/securityContext/readOnlyRootFilesystem"])).toEqual([19, 19]);
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, ["spec/template/spec/containers/[0]/args"])).toEqual([14, 16]);
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, ["metadata/annotations/a"])).toEqual([7, 7]);
    expect(anchorFinding(DEPLOY, "deploy.yaml", 23, 26, ["metadata/name"])).toEqual([26, 26]);
  });

  it("anchors a missing key to the deepest key that exists on its path", () => {
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, ["spec/template/spec/containers/[1]/resources/limits/cpu"])).toEqual([20, 20]);
    expect(anchorFinding(DEPLOY, "deploy.yaml", 3, 21, [])).toEqual([3, 3]);
  });

  it("finds a CloudFormation resource under Resources and maps its keys from there", () => {
    const cf = tf(
      'AWSTemplateFormatVersion: "2010-09-09"', // 1
      "Resources:", // 2
      "  WebSG:", // 3
      "    Type: AWS::EC2::SecurityGroup", // 4
      "    Properties:", // 5
      "      GroupDescription: web", // 6
      "      SecurityGroupIngress:", // 7
      "        - IpProtocol: tcp", // 8
      "          CidrIp: 0.0.0.0/0", // 9
      "  Logs:", // 10
      "    Type: AWS::S3::Bucket", // 11
    );
    expect(anchorFinding(cf, "stack.yaml", 3, 9, ["Properties/SecurityGroupIngress"])).toEqual([7, 9]);
    expect(anchorFinding(cf, "stack.yaml", 10, 11, ["Properties/LoggingConfiguration"])).toEqual([10, 10]);
  });

  it("anchors a JSON finding to the resource's first line", () => {
    expect(anchorFinding('{\n  "Resources": {\n    "A": {\n      "Type": "AWS::S3::Bucket"\n    }\n  }\n}\n', "stack.json", 3, 5, ["Properties"])).toEqual([3, 3]);
  });
});

describe("trivy causes that are whole blocks are anchored to their first line (4)", () => {
  it("HCL: a resource or nested block, never an attribute over several lines", () => {
    expect(blockCause(SG, "main.tf", 27, 32)).toEqual([27, 27]);
    expect(blockCause(SG, "main.tf", 13, 20)).toEqual([13, 13]);
    expect(blockCause(SG, "main.tf", 17, 19)).toEqual([17, 19]);
    expect(blockCause(SG, "main.tf", 10, 10)).toEqual([10, 10]);
    expect(blockCause(SG, "main.tf", 22, 24)).toEqual([22, 24]);
  });

  it("YAML: a mapping, a sequence item that is a mapping, a key over a sequence of mappings; never a list of scalars", () => {
    expect(blockCause(DEPLOY, "deploy.yaml", 12, 19)).toEqual([12, 12]);
    expect(blockCause(DEPLOY, "deploy.yaml", 17, 19)).toEqual([17, 17]);
    expect(blockCause(DEPLOY, "deploy.yaml", 11, 21)).toEqual([11, 11]);
    expect(blockCause(DEPLOY, "deploy.yaml", 5, 7)).toEqual([5, 5]);
    expect(blockCause(DEPLOY, "deploy.yaml", 14, 16)).toEqual([14, 16]);
    expect(blockCause(DEPLOY, "deploy.yaml", 3, 21)).toEqual([3, 3]);
  });
});

describe("which Terraform folders each scanner may read (6)", () => {
  it("reads module sources from top-level module blocks only, as HCL reads them", () => {
    const text = tf(
      'module "net" {',
      "  # the network",
      '  source = "./modules/net"',
      "}",
      'module "vpc" {',
      '  source  = "terraform-aws-modules/vpc/aws"',
      '  version = "5.0.0"',
      "}",
      'module "one" { source = "./one" }',
      'module "esc" {',
      '  source = "\\u002e/mod\\u0073"',
      "}",
      "terraform {",
      "  required_providers {",
      '    aws = { source = "hashicorp/aws" }',
      "  }",
      "}",
      "locals {",
      "  doc = <<-EOT",
      '    module "x" {',
      "    }",
      "  EOT",
      "}",
      "# module \"c\" { source = \"git::https://x\" }",
      'resource "x" "y" { source = "z" }',
    );
    expect(moduleSources(text, "main.tf")).toEqual(["./modules/net", "terraform-aws-modules/vpc/aws", "./one", "./mods"]);
    expect(moduleSources('{"module": {"a": {"source": "../a"}, "//": "note", "b": [{"source": "git::https://x"}]}}', "m.tf.json")).toEqual(["../a", "git::https://x"]);
  });

  // A folder withheld for a construct the gate does not model loses its
  // scan; the common ones of real configurations are read whole.
  it("reads a configuration with the constructs real ones use whole", () => {
    const text = tf(
      "/* Shop network */",
      'variable "enabled" {',
      "  type    = bool",
      "  default = true // on by default",
      "}",
      "",
      "locals {",
      "  tags = merge(var.tags, {",
      '    "team" = "shop" # owner',
      "  })",
      '  name = "${var.prefix}-%{ if var.enabled }on%{ else }off%{ endif }"',
      '  rules = { for k, v in var.rules : k => v if v.port != 22 }',
      '  first = [for r in var.list : upper(r)][0]',
      "  policy = jsonencode({",
      '    Version = "2012-10-17"',
      '    Statement = [{ Effect = "Allow", Action = ["s3:GetObject"], Resource = "*" }]',
      "  })",
      "  doc = <<EOT",
      'line with "quotes" and { braces',
      "EOT",
      "}",
      "",
      'resource "aws_security_group" "web" {',
      '  count = var.enabled ? 1 : 0',
      '  name  = "web"',
      '  dynamic "ingress" {',
      "    for_each = local.rules",
      "    content {",
      "      from_port   = ingress.value.port",
      "      to_port     = ingress.value.port",
      '      protocol    = "tcp"',
      "      cidr_blocks = ingress.value.cidrs",
      "    }",
      "  }",
      "  lifecycle {",
      "    create_before_destroy = true",
      "  }",
      "}",
      "",
      'module "east" {',
      '  source    = "./modules/region"',
      "  providers = { aws = aws.east }",
      "  depends_on = [aws_security_group.web]",
      '  user_data = templatefile("${path.module}/init.tpl", { name = local.name })',
      "}",
      "",
      'output "id" {',
      "  value = aws_security_group.web[*].id",
      "}",
    );
    expect(moduleSources(text, "main.tf")).toEqual(["./modules/region"]);
  });

  // Anything the gate cannot account for withholds the folder (null).
  it("reads no file it cannot account for whole: an expression, a template, a heredoc source, an open block, a duplicate key", () => {
    for (const source of ['"${var.base}/x"', "local.where", "<<EOT\n./x\nEOT", '"./a" "./b"', '"\\q"']) {
      expect(moduleSources(tf('module "m" {', `  source = ${source}`, "}"), "main.tf"), source).toBeNull();
    }
    expect(moduleSources(tf('module "m" {', '  source = "./a"', '  source = "./b"', "}"), "main.tf")).toBeNull();
    expect(moduleSources(tf('module "m" {', '  version = "1"', "}"), "main.tf")).toBeNull();
    expect(moduleSources(tf('module "m" {', '  source = "./a"'), "main.tf")).toBeNull();
    expect(moduleSources(tf('module "m" { source = "./a"', "}"), "main.tf")).toBeNull();
    expect(moduleSources(tf("\uFEFFlocals {", "}"), "main.tf")).toBeNull();
    expect(moduleSources('{"module": [{"a": {"source": 1}}]}', "m.tf.json")).toBeNull();
    expect(moduleSources('{"module": {"a": {"source": "./a"}}, "module": {"b": {"source": "./b"}}}', "m.tf.json")).toBeNull();
    expect(moduleSources('{"module": {"a": {"source": "${x}"}}}', "m.tf.json")).toBeNull();
    expect(moduleSources('{"module": "x"}', "m.tf.json")).toBeNull();
    expect(moduleSources('{"module": {}},', "m.tf.json")).toBeNull();
  });

  it("lets trivy read local modules that stay in the repository only, and checkov anything that stays in it", () => {
    expect(moduleVerdict("infra", ["./modules/net", "../shared"])).toEqual({ trivy: true, checkov: true });
    expect(moduleVerdict("infra", ["terraform-aws-modules/vpc/aws"])).toEqual({ trivy: false, checkov: true });
    expect(moduleVerdict("infra", ["git::https://example.com/x.git"])).toEqual({ trivy: false, checkov: true });
    expect(moduleVerdict("infra", ["../../outside"])).toEqual({ trivy: false, checkov: false });
    expect(moduleVerdict("", ["../x"])).toEqual({ trivy: false, checkov: false });
    expect(moduleVerdict("infra", ["./a/../../../x"])).toEqual({ trivy: false, checkov: false });
    expect(moduleVerdict("infra", ["/etc/x"])).toEqual({ trivy: false, checkov: false });
    expect(moduleVerdict("infra", [".hidden/x"])).toEqual({ trivy: false, checkov: true });
    expect(moduleVerdict("infra", [])).toEqual({ trivy: true, checkov: true });
  });
});

describe("hostile files are read in linear time (7)", () => {
  const N = 200_000;
  const cases: [string, string, "terraform" | "kubernetes"][] = [
    ["deep braces", `resource "a" "b" {\n${"x {\n".repeat(N / 4)}`, "terraform"],
    ["deep brackets in an attribute", `resource "a" "b" {\n  x = ${"[".repeat(N)}\n}\n`, "terraform"],
    ["many heredoc words left open", `resource "a" "b" {\n${Array.from({ length: N / 20 }, (_, k) => `  x${k} = <<E${k}\n`).join("")}}\n`, "terraform"],
    ["deep indentation", Array.from({ length: 2000 }, (_, k) => `${" ".repeat(k)}k${k}:\n`).join(""), "kubernetes"],
    ["deep sequences", `a:\n${Array.from({ length: 2000 }, (_, k) => `${" ".repeat(k)}- \n`).join("")}`, "kubernetes"],
  ];
  for (const [what, text, kind] of cases) {
    it(what, () => {
      const started = performance.now();
      anchorFinding(text, kind === "terraform" ? "a.tf" : "a.yaml", 1, 3, ["x/[0]/y"]);
      blockCause(text, kind === "terraform" ? "a.tf" : "a.yaml", 1, 3);
      if (kind === "terraform") moduleSources(text, "a.tf");
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});
