import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CodeHighlight, { normalizeCodeLanguage } from '../src/components/CodeHighlight';

// These 21 language labels are returned by the repository reference-file parser.
const referenceLanguages = [
  ['C++', 'cpp', '#include <iostream>\nint main() { return 0; }\n'],
  ['C', 'c', '#include <stdio.h>\nint main(void) { return 0; }\n'],
  ['Python', 'python', 'def solve():\n\tprint("hello")\n'],
  ['Java', 'java', 'public class Main { public static void main(String[] args) {} }\n'],
  ['Rust', 'rust', 'fn main() { let answer: i32 = 42; println!("{}", answer); }\n'],
  ['Go', 'go', 'package main\nfunc main() { var answer int = 42 }\n'],
  ['C#', 'csharp', 'public class Program { public static void Main() { int n = 42; } }\n'],
  ['JavaScript', 'javascript', 'const solve = (n) => console.log("answer", n);\n'],
  ['TypeScript', 'typescript', 'const answer: number = 42;\n'],
  ['Kotlin', 'kotlin', 'fun main() { val answer: Int = 42; println(answer) }\n'],
  ['Ruby', 'ruby', 'def solve(n)\n  puts "answer #{n}"\nend\n'],
  ['Swift', 'swift', 'func solve(_ n: Int) -> Int { return n + 1 }\n'],
  ['Scala', 'scala', 'object Main { def main(args: Array[String]): Unit = println("hello") }\n'],
  ['PHP', 'php', '<?php function solve($n) { return $n + 1; } ?>\n'],
  ['Pascal', 'delphi', 'program Main;\nvar answer: integer;\nbegin answer := 42; writeln(answer); end.\n'],
  ['D', 'd', 'import std.stdio;\nvoid main() { int answer = 42; writeln(answer); }\n'],
  ['Haskell', 'haskell', 'module Main where\nmain :: IO ()\nmain = putStrLn "hello"\n'],
  ['OCaml', 'ocaml', 'let rec solve n = if n = 0 then 1 else n * solve (n - 1)\n'],
  ['F#', 'fsharp', 'let rec solve n = if n = 0 then 1 else n * solve (n - 1)\n'],
  ['Perl', 'perl', 'use strict;\nmy $answer = 42;\nprint "$answer\\n";\n'],
  ['R', 'r', 'solve <- function(n) { return(n + 1) }\n'],
] as const;

function render(code: string, language?: string) {
  return renderToStaticMarkup(<CodeHighlight code={code} language={language} />);
}

function plaintext(code: string) {
  return renderToStaticMarkup(<pre className="code-highlight"><code>{code}</code></pre>);
}

function removeTokenSpans(markup: string) {
  return markup.replace(/<span(?: class="[^"]*")?>|<\/span>/g, '');
}

describe('reference code highlighting', () => {
  it.each(referenceLanguages)('highlights the repository label %s and preserves exact source', (label, grammar, code) => {
    expect(normalizeCodeLanguage(label)).toBe(grammar);
    const markup = render(code, label);
    expect(markup).toMatch(/<span class="[^"]*hljs-/);
    expect(removeTokenSpans(markup)).toBe(plaintext(code));
  });

  it.each([
    ['C / C++', 'cpp'], ['C/C++', 'cpp'], ['.h', 'cpp'], ['h', 'cpp'], ['hpp', 'cpp'],
    ['.hs', 'haskell'], ['hs', 'haskell'], ['.ml', 'ocaml'], ['ml', 'ocaml'],
    ['.fs', 'fsharp'], ['fs', 'fsharp'], ['fsharp', 'fsharp'], ['F#', 'fsharp'],
    ['.pas', 'delphi'], ['pas', 'delphi'], ['.rb', 'ruby'], ['rb', 'ruby'], ['.pl', 'perl'], ['pl', 'perl'],
    ['language-scala', 'scala'], [' GNU C++20 ', 'cpp'], ['Python 3.12', 'python'],
  ])('normalizes and highlights reference alias %s', (label, grammar) => {
    expect(normalizeCodeLanguage(label)).toBe(grammar);
    const source = referenceLanguages.find(([, name]) => name === grammar)![2];
    expect(render(source, label)).toMatch(/<span class="[^"]*hljs-/);
  });

  it('escapes literal HTML in highlighted source while preserving tabs and CRLF', () => {
    const source = 'const char* html = "<img src=x onerror=alert(1)>";\r\n\t// <script>alert("x")</script>\r\n';
    const markup = render(source, 'C++');
    expect(markup).toContain('hljs-string');
    expect(markup).not.toMatch(/<(?:img|script)\b/);
    expect(markup).toContain('&lt;img');
    expect(removeTokenSpans(markup)).toBe(plaintext(source));
  });

  it.each([undefined, 'unknown-language', 'constructor', '__proto__', 'text', '文本'])('renders unsupported or plain label %s as escaped plaintext', label => {
    const source = '<script>alert("x")</script>\r\n\tconst answer = 42;\n';
    expect(render(source, label)).toBe(plaintext(source));
  });

  it('keeps files over 128 KiB as exact escaped plaintext', () => {
    const source = 'int answer = 42;\n' + ' '.repeat(128 * 1024) + '<img src=x>\n';
    expect(render(source, 'cpp')).toBe(plaintext(source));
  });

  it('checks the UTF-8 byte limit for non-ASCII files below the character limit', () => {
    const source = '// ' + '题'.repeat(44 * 1024) + '\nint answer = 42;\n';
    expect(source.length).toBeLessThan(128 * 1024);
    expect(new TextEncoder().encode(source).byteLength).toBeGreaterThan(128 * 1024);
    expect(render(source, 'cpp')).toBe(plaintext(source));
  });
});
