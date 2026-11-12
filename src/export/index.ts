import type { ExportBundle, ExportFormat, ExportResult, ExportScope } from '../shared/types.ts';
import { exportFilename, exportMime, buildJsonExport, buildObservationsCsv, buildProductsCsv } from './csv.ts';

export * from './csv.ts';

export function buildExport(
  bundle: ExportBundle,
  format: ExportFormat,
  scope: ExportScope,
  date = new Date(),
): ExportResult {
  let content: string;
  if (format === 'products-csv') content = buildProductsCsv(bundle.products);
  else if (format === 'observations-csv') content = buildObservationsCsv(bundle.observations);
  else content = buildJsonExport(bundle);
  return {
    ok: true,
    filename: exportFilename(format, date, scope),
    content,
    mime: exportMime(format),
  };
}
