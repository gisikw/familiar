export type ExecResult = { stdout: string; stderr: string; code: number | null };
export type StuffExec = (command: string, args: string[]) => Promise<ExecResult>;

const itemMetadata = JSON.stringify({ source: { kind: "pi-quick-capture" } });
const noteMetadata = JSON.stringify({ kind: "capture-context", source: { kind: "pi-quick-capture" } });

export async function createStuffCapture(exec: StuffExec, title: string, description = ""): Promise<string> {
  const name = title.trim();
  if (!name) throw new Error("Item title is required");
  const added = await exec("stuff", ["add", name, "--meta", itemMetadata]);
  if (added.code !== 0) throw new Error(briefDiagnostic("stuff add failed", added.stderr));
  const id = added.stdout.trim();
  if (!/^item_[a-z0-9]+$/.test(id)) throw new Error("stuff add returned an invalid Item ID");

  const text = description.trim();
  if (text) {
    const noted = await exec("stuff", ["note", "add", id, text, "--meta", noteMetadata]);
    if (noted.code !== 0) {
      throw new Error(`${briefDiagnostic("Item created, but Note creation failed", noted.stderr)} (Item ${id})`);
    }
  }
  return id;
}

function briefDiagnostic(prefix: string, stderr: string): string {
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 240);
  return detail ? `${prefix}: ${detail}` : prefix;
}
