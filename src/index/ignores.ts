import * as vscode from "vscode";
import ignore, { type Ignore } from "ignore";

// Builds a predicate that decides whether a workspace-relative path should be
// skipped, honoring (1) the user's VSCode files.exclude / search.exclude and
// (2) every .gitignore in the repo. This is on top of the hardcoded EXCLUDE
// glob the file scan already applies.
export async function buildIgnore(excludeGlob: string): Promise<(rel: string) => boolean> {
  const ig: Ignore = ignore();

  // VSCode exclude settings are { glob: boolean } maps.
  for (const section of ["files", "search"]) {
    const map =
      vscode.workspace.getConfiguration(section).get<Record<string, boolean>>("exclude") ?? {};
    for (const [glob, on] of Object.entries(map)) {
      if (on) ig.add(glob);
    }
  }

  // Collect .gitignore files; nested ones apply relative to their own folder,
  // so prefix their patterns with that folder.
  const gitignores = await vscode.workspace.findFiles("**/.gitignore", excludeGlob, 100);
  for (const uri of gitignores) {
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const rel = vscode.workspace.asRelativePath(uri, false);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      ig.add(text.split(/\r?\n/).map((l) => prefixPattern(l, dir)));
    } catch {
      /* unreadable .gitignore — skip */
    }
  }

  return (rel: string) => {
    if (!rel || rel.startsWith("..")) return false;
    try {
      return ig.ignores(rel);
    } catch {
      return false;
    }
  };
}

// Rewrite a gitignore line so a nested .gitignore's pattern matches relative to
// the repo root. Follows gitignore anchoring: a pattern with an internal/leading
// slash is anchored to the .gitignore's folder; one without (e.g. "*.snap",
// "build/") matches at ANY depth below it — so we insert "/**/".
function prefixPattern(line: string, dir: string): string {
  const t = line.trim();
  if (!t || t.startsWith("#") || dir === "") return line;
  let neg = "";
  let body = t;
  if (body.startsWith("!")) {
    neg = "!";
    body = body.slice(1);
  }
  const anchored = body.replace(/\/+$/, "").includes("/"); // internal or leading slash
  if (body.startsWith("/")) body = body.slice(1);
  return anchored ? `${neg}${dir}/${body}` : `${neg}${dir}/**/${body}`;
}
