import { testSuiteSchema, type TestSuite } from "@device-robot/contracts";
import { parse as parseYaml } from "yaml";

export {
  sourceEvidenceSchema,
  testCaseSchema,
  testStepSchema,
  testSuiteSchema,
  type SourceEvidence,
  type TestCase,
  type TestStep,
  type TestSuite,
} from "@device-robot/contracts";

export class TestDslParseError extends Error {}

export function parseTestSuiteDocument(document: string, fileName?: string): TestSuite {
  const content = document.replace(/^\uFEFF/u, "").trim();
  if (content.length === 0) {
    throw new TestDslParseError("测试用例文件为空。");
  }

  try {
    const value = fileName?.toLocaleLowerCase().endsWith(".json")
      ? JSON.parse(content)
      : parseYaml(content, { uniqueKeys: true });
    return testSuiteSchema.parse(value);
  } catch (error) {
    if (error instanceof TestDslParseError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "文件格式无效。";
    throw new TestDslParseError(`测试 DSL 校验失败：${message}`);
  }
}
