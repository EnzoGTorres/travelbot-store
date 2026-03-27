import { runGitHubStoreIntegrationTest } from "./store";

function readDryRunFlag(): boolean {
  const rawValue = process.env.DRY_RUN?.trim();

  if (!rawValue) {
    return false;
  }

  const value = rawValue.toLowerCase();

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error("DRY_RUN debe ser un booleano valido.");
}

async function main() {
  const result = await runGitHubStoreIntegrationTest({
    dryRun: readDryRunFlag()
  });

  console.log("");
  console.log("[GitHub Store] Resumen final");
  console.log(
    `[GitHub Store] dryRun=${result.dryRun} repoAccessible=${result.repoAccessible} fileRead=${result.fileRead} jsonValid=${result.jsonValid} writeSucceeded=${result.writeSucceeded} verificationSucceeded=${result.verificationSucceeded} revertSucceeded=${result.revertSucceeded}`
  );

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("[GitHub Store] Diagnostico fallido:", error.message);
  } else {
    console.error("[GitHub Store] Diagnostico fallido:", error);
  }

  process.exitCode = 1;
});
