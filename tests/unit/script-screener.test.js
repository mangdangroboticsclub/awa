"use strict";

const {
  screen,
  screenOrThrow,
  ScriptRejectedError,
} = require("../../src/services/script-screener");
const {
  validScript,
  scriptWithProcess,
  scriptWithRequire,
  scriptWithEval,
  scriptWithFunction,
  scriptNoExecute,
  oversizedScript,
  scriptWithConstExecute,
  scriptWithGlobal,
  scriptWithImport,
} = require("../fixtures/scripts/screener-fixtures");

describe("ScriptScreener", () => {
  describe("screen()", () => {
    it("should pass a valid script", () => {
      const result = screen(validScript);
      expect(result.passed).toBe(true);
    });

    it("should pass a script with const-assigned execute", () => {
      const result = screen(scriptWithConstExecute);
      expect(result.passed).toBe(true);
    });

    it("should reject scripts containing 'process'", () => {
      const result = screen(scriptWithProcess);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("process");
    });

    it("should reject scripts containing 'require'", () => {
      const result = screen(scriptWithRequire);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("require");
    });

    it("should reject scripts containing 'eval('", () => {
      const result = screen(scriptWithEval);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("eval");
    });

    it("should reject scripts containing 'Function('", () => {
      const result = screen(scriptWithFunction);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Function");
    });

    it("should reject scripts containing 'global'", () => {
      const result = screen(scriptWithGlobal);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("global");
    });

    it("should reject scripts containing 'import('", () => {
      const result = screen(scriptWithImport);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("import");
    });

    it("should reject scripts with no execute function", () => {
      const result = screen(scriptNoExecute);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("execute");
    });

    it("should reject oversized scripts (>10MB)", () => {
      const result = screen(oversizedScript);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("size");
    });

    it("should use custom maxSizeBytes when provided", () => {
      const result = screen("too big", { maxSizeBytes: 5 });
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("size");
    });
  });

  describe("screenOrThrow()", () => {
    it("should return result for valid scripts", () => {
      const result = screenOrThrow(validScript);
      expect(result.passed).toBe(true);
    });

    it("should throw ScriptRejectedError for invalid scripts", () => {
      expect(() => screenOrThrow(scriptWithProcess)).toThrow(
        ScriptRejectedError,
      );
    });
  });
});
