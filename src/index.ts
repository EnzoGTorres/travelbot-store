import { config } from "./config";
import { ChecksRunPersistenceError, runChecksWithSummary } from "./runtime";
import { testGitHubStoreConnection } from "./store";

async function main() {
  if (config.diagnostics.runGithubStoreOnStartup) {
    const result = await testGitHubStoreConnection();

    if (!result.ok) {
      process.exitCode = 1;
    }

    return;
  }

  const summary = await runChecksWithSummary();

  console.log("Chequeo de alertas de vuelos");
  console.log("----------------------------");
  console.log(`Store: ${summary.storeLabel}`);
  console.log(`Modo: ${summary.dryRun ? "dry-run" : "normal"}`);

  if (!config.telegram.isConfigured()) {
    console.warn(
      "Advertencia: Telegram no esta configurado. El chequeo continua, pero no se enviaran mensajes."
    );
  }

  if (summary.checkedCount === 0) {
    console.log("No hay busquedas activas para revisar.");
    return;
  }

  console.log(
    `Resumen: chequeadas=${summary.checkedCount} elegibles=${summary.alertsEligible} alertas=${summary.alertsSent} skipped=${summary.skipped} errores=${summary.errors} duracionMs=${summary.durationMs}`
  );

  for (const detail of summary.details) {
    console.log("");
    console.log(detail.log);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ChecksRunPersistenceError) {
    console.error("La corrida termino, pero fallo la persistencia final:");
    console.error(error.message);
    console.error(
      `Resumen parcial: chequeadas=${error.summary.checkedCount} elegibles=${error.summary.alertsEligible} alertas=${error.summary.alertsSent} errores=${error.summary.errors}`
    );
    return;
  }

  if (error instanceof Error) {
    console.error("No se pudo ejecutar la consulta de vuelos:", error.message);
    return;
  }

  console.error("No se pudo ejecutar la consulta de vuelos:", error);
});
