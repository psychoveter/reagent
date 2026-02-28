/**
 * Reagent recursive-descent parser — v0.0.14
 *
 * Parses a Reagent source string into the typed AST defined in ast.ts.
 * Zone bodies are captured as raw text (brace-balanced, string/comment-aware).
 */
import type { Loc, Program } from "./ast.js";
export type ParseError = {
    code: string;
    message: string;
    loc: Loc;
};
export type ParseResult = {
    ok: boolean;
    ast: Program;
    errors: ParseError[];
};
export declare function parseProgram(src: string): ParseResult;
