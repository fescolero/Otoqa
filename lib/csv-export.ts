export interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => string | number | undefined | null;
}

export function exportToCSV<T>(
  rows: Array<T>,
  columns: Array<CsvColumn<T>>,
  filename: string
) {
  const headers = columns.map((col) => col.header);
  const csvRows = rows.map((row) =>
    columns.map((col) => {
      const value = col.accessor(row);
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
  );

  const csvContent = [
    headers.join(','),
    ...csvRows.map((row) => row.join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function generateCSVTemplate(
  columns: Array<string>,
  filename: string
) {
  const csvContent = columns.join(',');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}-template.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
