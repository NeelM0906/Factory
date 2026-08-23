import type { DataPathPolicy } from "./path-policy.js";

export const isExactUnusedScaffolding = async (
  paths: DataPathPolicy,
  component: string,
  commandEntries: readonly Readonly<{ readonly name: string; readonly type: string }>[]
): Promise<boolean> => {
  const commandRoot = `commands/${component}`;
  if (
    commandEntries.length !== 3 ||
    !["receipt", "control", "spool"].every((name) =>
      commandEntries.some((entry) => entry.name === name && entry.type === "directory")
    )
  ) {
    return false;
  }
  const spool = await paths.listExistingDirectory(`${commandRoot}/spool`, 2);
  if (
    spool === undefined ||
    spool.length !== 2 ||
    !["events", "transcript"].every((name) =>
      spool.some((entry) => entry.name === name && entry.type === "directory")
    )
  ) {
    return false;
  }
  for (const directory of ["receipt", "control", "spool/events", "spool/transcript"]) {
    let entries;
    try {
      entries = await paths.listExistingDirectory(`${commandRoot}/${directory}`, 0);
    } catch {
      return false;
    }
    if (entries === undefined || entries.length !== 0) return false;
  }
  return true;
};
