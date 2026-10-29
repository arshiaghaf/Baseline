// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { Parser } from "htmlparser2";
import type { ReleaseNotesBlock, ReleaseNotesFormat } from "../shared/releaseNotes";

const maxCharacters = 64_000;
const maxBlocks = 200;

/** HTML is parsed as data and reduced to inert text; no publisher markup reaches Electron. */
export function releaseNotesText(
  content: string,
  format: ReleaseNotesFormat
): { blocks: ReleaseNotesBlock[]; truncated: boolean } {
  const blocks: ReleaseNotesBlock[] = [];
  let characters = 0;
  let truncated = false;
  const append = (type: ReleaseNotesBlock["type"], raw: string) => {
    const text = raw
      .replace(/\r\n?/gu, "\n")
      .replace(/[\t ]+/gu, " ")
      .trim();
    if (!text) return;
    if (blocks.length >= maxBlocks || characters >= maxCharacters) {
      truncated = true;
      return;
    }
    const bounded = text.slice(0, maxCharacters - characters);
    if (bounded.length < text.length) truncated = true;
    blocks.push({ type, text: bounded });
    characters += bounded.length;
  };

  if (format !== "html") {
    for (const paragraph of content.replace(/\r\n?/gu, "\n").split(/\n\s*\n/u)) {
      if (format === "plain-text") append("paragraph", paragraph);
      else {
        for (const line of paragraph.split("\n")) {
          const heading = /^#{1,6}\s+(.+)$/u.exec(line);
          const list = /^\s*(?:[-*+] |\d+\. )(.+)$/u.exec(line);
          append(
            heading ? "heading" : list ? "list-item" : "paragraph",
            heading?.[1] ?? list?.[1] ?? line
          );
        }
      }
    }
    return { blocks, truncated };
  }

  const ignored = new Set([
    "script",
    "style",
    "template",
    "head",
    "iframe",
    "object",
    "svg",
    "canvas",
    "nav",
    "footer",
    "form"
  ]);
  const boundaries = new Set(["p", "div", "section", "article", "li", "blockquote", "pre", "tr"]);
  const stack: Array<{ name: string; ignored: boolean }> = [];
  let ignoredDepth = 0;
  let buffer = "";
  let type: ReleaseNotesBlock["type"] = "paragraph";
  const flush = () => {
    append(type, buffer);
    buffer = "";
    type = "paragraph";
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const skip =
          ignored.has(name) ||
          Object.hasOwn(attributes, "hidden") ||
          attributes["aria-hidden"] === "true" ||
          /display\s*:\s*none/iu.test(attributes.style ?? "");
        stack.push({ name, ignored: skip });
        if (skip) ignoredDepth++;
        if (ignoredDepth) return;
        if (boundaries.has(name) || /^h[1-6]$/u.test(name)) flush();
        if (/^h[1-6]$/u.test(name)) type = "heading";
        else if (name === "li") type = "list-item";
        if (name === "br") buffer += "\n";
      },
      ontext(text) {
        if (ignoredDepth) return;
        const remaining = maxCharacters - characters - buffer.length;
        if (remaining > 0) {
          if (text.length > remaining) truncated = true;
          buffer += text.slice(0, remaining);
        } else truncated = true;
      },
      onclosetag(name) {
        const entry = stack.pop();
        if (entry?.ignored) ignoredDepth--;
        if (ignoredDepth || entry?.ignored) return;
        if (boundaries.has(name) || /^h[1-6]$/u.test(name)) flush();
      }
    },
    { decodeEntities: true }
  );
  parser.write(content);
  parser.end();
  flush();
  return { blocks, truncated };
}
