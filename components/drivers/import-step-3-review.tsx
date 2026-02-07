'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Loader2, AlertCircle, CheckCircle, Wand2 } from 'lucide-react';
import { CSVRow, ColumnMapping, ValidationError, DuplicateDriver } from './csv-import-wizard';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuth } from '@workos-inc/authkit-nextjs/components';

interface ImportStep3ReviewProps {
  parsedData: CSVRow[];
  columnMappings: ColumnMapping[];
  validRows: CSVRow[];
  errors: ValidationError[];
  duplicates: DuplicateDriver[];
  onErrorsChange: (errors: ValidationError[]) => void;
  onDuplicatesChange: (duplicates: DuplicateDriver[]) => void;
  onValidRowsChange: (rows: CSVRow[]) => void;
  onImportComplete: () => void;
}

type FilterView = 'all' | 'ready' | 'errors' | 'duplicates';

interface ErrorCell {
  field: string;
  error: string;
  suggestion?: string;
}

// Validation helpers
const validateEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validatePhone = (phone: string): { error: string | null; suggestion?: string } => {
  const cleaned = phone.replace(/\D/g, '');
  
  // Check if it's valid length
  if (cleaned.length < 10) {
    return { error: 'Phone number too short' };
  }
  if (cleaned.length > 11) {
    return { error: 'Phone number too long' };
  }
  
  // If valid length but has formatting or extra characters, suggest formatted version
  const formatted = formatPhoneNumber(phone);
  if (phone !== formatted) {
    return { error: null, suggestion: formatted };
  }
  
  return { error: null };
};

const validateDate = (dateStr: string): { valid: boolean; suggestion?: string } => {
  if (!dateStr) return { valid: true };

  // Try to parse the date
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    // Valid date - check if it's already in ISO format
    const isoFormat = /^\d{4}-\d{2}-\d{2}$/;
    if (isoFormat.test(dateStr)) {
      return { valid: true };
    } else {
      // Valid date but not ISO format - suggest ISO format
      return {
        valid: false,
        suggestion: date.toISOString().split('T')[0], // YYYY-MM-DD
      };
    }
  }

  // Try to extract numbers and create a valid date
  const numbers = dateStr.match(/\d+/g);
  if (numbers && numbers.length === 3) {
    // Assume MM/DD/YYYY or similar
    const [first, second, third] = numbers;
    let testDate: Date | null = null;

    // Try MM/DD/YYYY
    if (parseInt(first) <= 12) {
      testDate = new Date(parseInt(third), parseInt(first) - 1, parseInt(second));
    }
    // Try DD/MM/YYYY
    if (!testDate || isNaN(testDate.getTime())) {
      testDate = new Date(parseInt(third), parseInt(second) - 1, parseInt(first));
    }

    if (testDate && !isNaN(testDate.getTime())) {
      return {
        valid: false,
        suggestion: testDate.toISOString().split('T')[0], // YYYY-MM-DD
      };
    }
  }

  return { valid: false };
};

// Normalize date to ISO 8601 format (YYYY-MM-DD)
const normalizeDate = (dateStr: string): string => {
  if (!dateStr) return dateStr;
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  return dateStr;
};

const formatPhoneNumber = (phone: string): string => {
  const cleaned = phone.replace(/\D/g, '');
  
  // If exactly 10 digits, format as XXX-XXX-XXXX
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  
  // If 11 digits (with leading 1), remove it and format
  if (cleaned.length === 11) {
    return `${cleaned.slice(1, 4)}-${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  
  // If too long, take first 10 digits
  if (cleaned.length > 11) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
  }
  
  // If too short but has some digits, return cleaned version
  if (cleaned.length > 0) {
    return cleaned;
  }
  
  return phone;
};

export function ImportStep3Review({
  parsedData,
  columnMappings,
  validRows,
  errors,
  duplicates,
  onErrorsChange,
  onDuplicatesChange,
  onValidRowsChange,
  onImportComplete,
}: ImportStep3ReviewProps) {
  const { user } = useAuth();
  const [isValidating, setIsValidating] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [mappedRows, setMappedRows] = useState<any[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [filterView, setFilterView] = useState<FilterView>('all');
  const [rowErrors, setRowErrors] = useState<Map<number, ErrorCell[]>>(new Map());

  const existingDrivers = useQuery(
    api.drivers.list,
    organizationId ? { organizationId, includeDeleted: false } : 'skip',
  );

  const bulkImport = useMutation(api.drivers.create);

  useEffect(() => {
    async function fetchOrganizationId() {
      try {
        const response = await fetch('/api/organization');
        const data = await response.json();
        setOrganizationId(data.organizationId);
      } catch (error) {
        console.error('Failed to fetch organization ID:', error);
      }
    }
    fetchOrganizationId();
  }, []);

  useEffect(() => {
    if (parsedData.length > 0 && columnMappings.length > 0 && existingDrivers && !mappedRows.length) {
      validateAndMapData();
    }
  }, [parsedData, columnMappings, existingDrivers]);

  const validateAndMapData = () => {
    setIsValidating(true);

    const newErrors: ValidationError[] = [];
    const newDuplicates: DuplicateDriver[] = [];
    const newMappedRows: any[] = [];
    const errorMap = new Map<number, ErrorCell[]>();

    parsedData.forEach((row, rowIndex) => {
      const mappedRow: any = {};
      const rowErrorCells: ErrorCell[] = [];

      columnMappings.forEach((mapping) => {
        if (mapping.destinationField !== 'ignore') {
          mappedRow[mapping.destinationField] = row[mapping.sourceColumn] || '';
        }
      });

      newMappedRows.push(mappedRow);

      // Validate required fields
      const requiredFields = [
        'firstName',
        'lastName',
        'email',
        'phone',
        'licenseNumber',
        'licenseState',
        'licenseExpiration',
        'licenseClass',
        'hireDate',
        'employmentStatus',
        'employmentType',
      ];

      requiredFields.forEach((field) => {
        if (!mappedRow[field]) {
          const error = { field, error: 'Required field' };
          newErrors.push({ rowIndex, ...error, value: '' });
          rowErrorCells.push(error);
        }
      });

      // Validate email
      if (mappedRow.email && !validateEmail(mappedRow.email)) {
        const error = { field: 'email', error: 'Invalid email format' };
        newErrors.push({ rowIndex, ...error, value: mappedRow.email });
        rowErrorCells.push(error);
      }

      // Validate phone
      if (mappedRow.phone) {
        const phoneValidation = validatePhone(mappedRow.phone);
        const formatted = formatPhoneNumber(mappedRow.phone);
        
        if (phoneValidation.error) {
          const error = {
            field: 'phone',
            error: phoneValidation.error,
            suggestion: formatted !== mappedRow.phone ? formatted : undefined,
          };
          newErrors.push({ rowIndex, ...error, value: mappedRow.phone });
          rowErrorCells.push(error);
        } else if (phoneValidation.suggestion) {
          // Valid but needs formatting
          const error = {
            field: 'phone',
            error: 'Format suggestion',
            suggestion: phoneValidation.suggestion,
          };
          newErrors.push({ rowIndex, ...error, value: mappedRow.phone });
          rowErrorCells.push(error);
        }
      }

      // Validate dates
      [
        'licenseExpiration',
        'hireDate',
        'dateOfBirth',
        'medicalExpiration',
        'badgeExpiration',
        'twicExpiration',
        'terminationDate',
        'preEmploymentCheckDate',
      ].forEach((field) => {
        if (mappedRow[field]) {
          const dateValidation = validateDate(mappedRow[field]);
          if (!dateValidation.valid) {
            const error = {
              field,
              error: 'Invalid date format',
              suggestion: dateValidation.suggestion,
            };
            newErrors.push({ rowIndex, ...error, value: mappedRow[field] });
            rowErrorCells.push(error);
          }
        }
      });

      // Check for duplicates
      if (existingDrivers) {
        const duplicate = existingDrivers.find(
          (d) =>
            d.email.toLowerCase() === mappedRow.email?.toLowerCase() ||
            d.licenseNumber?.toLowerCase() === mappedRow.licenseNumber?.toLowerCase(),
        );

        if (duplicate) {
          newDuplicates.push({
            rowIndex,
            incomingData: mappedRow,
            existingDriver: duplicate,
            matchedOn:
              duplicate.email.toLowerCase() === mappedRow.email?.toLowerCase() ? 'email' : 'license number',
          });
        }
      }

      if (rowErrorCells.length > 0) {
        errorMap.set(rowIndex, rowErrorCells);
      }
    });

    setMappedRows(newMappedRows);
    setRowErrors(errorMap);
    onErrorsChange(newErrors);
    onDuplicatesChange(newDuplicates);

    const errorRowIndices = new Set(newErrors.map((e) => e.rowIndex));
    const duplicateRowIndices = new Set(newDuplicates.map((d) => d.rowIndex));
    const valid = newMappedRows.filter((_, index) => !errorRowIndices.has(index) && !duplicateRowIndices.has(index));

    onValidRowsChange(valid);
    setIsValidating(false);
  };

  const handleCellEdit = (rowIndex: number, field: string, newValue: string) => {
    const updated = [...mappedRows];
    updated[rowIndex] = { ...updated[rowIndex], [field]: newValue };
    setMappedRows(updated);

    // Remove error for this field if it exists
    const updatedErrors = errors.filter((e) => !(e.rowIndex === rowIndex && e.field === field));
    onErrorsChange(updatedErrors);

    // Update error map
    const newErrorMap = new Map(rowErrors);
    const rowErr = newErrorMap.get(rowIndex)?.filter((e) => e.field !== field) || [];
    if (rowErr.length > 0) {
      newErrorMap.set(rowIndex, rowErr);
    } else {
      newErrorMap.delete(rowIndex);
    }
    setRowErrors(newErrorMap);

    // Recalculate valid rows
    const errorRowIndices = new Set(updatedErrors.map((e) => e.rowIndex));
    const duplicateRowIndices = new Set(duplicates.map((d) => d.rowIndex));
    const valid = updated.filter((_, index) => !errorRowIndices.has(index) && !duplicateRowIndices.has(index));
    onValidRowsChange(valid);
  };

  const handleSkipDuplicate = (rowIndex: number) => {
    const updated = duplicates.filter((d) => d.rowIndex !== rowIndex);
    onDuplicatesChange(updated);
  };

  const handleImport = async () => {
    if (!user || !organizationId) return;

    setIsImporting(true);

    try {
      for (const row of validRows) {
        // Normalize all date fields to ISO 8601 format
        const normalizedRow = {
          ...row,
          dateOfBirth: row.dateOfBirth ? normalizeDate(row.dateOfBirth) : undefined,
          licenseExpiration: normalizeDate(row.licenseExpiration),
          medicalExpiration: row.medicalExpiration ? normalizeDate(row.medicalExpiration) : undefined,
          badgeExpiration: row.badgeExpiration ? normalizeDate(row.badgeExpiration) : undefined,
          twicExpiration: row.twicExpiration ? normalizeDate(row.twicExpiration) : undefined,
          hireDate: normalizeDate(row.hireDate),
          terminationDate: row.terminationDate ? normalizeDate(row.terminationDate) : undefined,
          preEmploymentCheckDate: row.preEmploymentCheckDate ? normalizeDate(row.preEmploymentCheckDate) : undefined,
          organizationId,
          createdBy: user.id,
        };

        await bulkImport(normalizedRow as Parameters<typeof bulkImport>[0]);
      }

      onImportComplete();
    } catch (error) {
      console.error('Import failed:', error);
      alert('Failed to import drivers. Please try again.');
    } finally {
      setIsImporting(false);
    }
  };

  const getFilteredRows = () => {
    const errorRowIndices = new Set(errors.map((e) => e.rowIndex));
    const duplicateRowIndices = new Set(duplicates.map((d) => d.rowIndex));

    return mappedRows
      .map((row, index) => ({ row, index }))
      .filter(({ index }) => {
        if (filterView === 'all') return true;
        if (filterView === 'ready') return !errorRowIndices.has(index) && !duplicateRowIndices.has(index);
        if (filterView === 'errors') return errorRowIndices.has(index);
        if (filterView === 'duplicates') return duplicateRowIndices.has(index);
        return true;
      });
  };

  const displayColumns = [
    { key: 'firstName', label: 'First Name', width: '120px' },
    { key: 'middleName', label: 'Middle Name', width: '120px' },
    { key: 'lastName', label: 'Last Name', width: '120px' },
    { key: 'email', label: 'Email', width: '180px' },
    { key: 'phone', label: 'Phone', width: '120px' },
    { key: 'dateOfBirth', label: 'Date of Birth', width: '110px' },
    { key: 'ssn', label: 'SSN', width: '110px' },
    { key: 'licenseNumber', label: 'License #', width: '110px' },
    { key: 'licenseState', label: 'License State', width: '90px' },
    { key: 'licenseExpiration', label: 'License Exp', width: '110px' },
    { key: 'licenseClass', label: 'License Class', width: '100px' },
    { key: 'medicalExpiration', label: 'Medical Exp', width: '110px' },
    { key: 'badgeExpiration', label: 'Badge Exp', width: '110px' },
    { key: 'twicExpiration', label: 'TWIC Exp', width: '110px' },
    { key: 'hireDate', label: 'Hire Date', width: '110px' },
    { key: 'employmentStatus', label: 'Employment Status', width: '130px' },
    { key: 'employmentType', label: 'Employment Type', width: '130px' },
    { key: 'terminationDate', label: 'Termination Date', width: '120px' },
    { key: 'preEmploymentCheckDate', label: 'Pre-Employment Check', width: '150px' },
    { key: 'address', label: 'Address', width: '180px' },
    { key: 'address2', label: 'Address Line 2', width: '150px' },
    { key: 'city', label: 'City', width: '120px' },
    { key: 'state', label: 'State', width: '80px' },
    { key: 'zipCode', label: 'ZIP Code', width: '90px' },
    { key: 'emergencyContactName', label: 'Emergency Contact', width: '150px' },
    { key: 'emergencyContactPhone', label: 'Emergency Phone', width: '130px' },
  ];

  if (isValidating) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
        <p className="text-lg font-medium">Validating your data...</p>
        <p className="text-sm text-muted-foreground">Checking for errors and duplicates</p>
      </div>
    );
  }

  const errorRowCount = rowErrors.size;
  const duplicateRowCount = duplicates.length;
  const readyRowCount = parsedData.length - errorRowCount - duplicateRowCount;
  const filteredRows = getFilteredRows();

  return (
    <div className="flex flex-col h-full">
      {/* Compressed Header */}
      <div className="flex-shrink-0 mb-3">
        <h2 className="text-xl font-semibold mb-1">Review & Repair Data</h2>
        <p className="text-sm text-muted-foreground">
          Found {parsedData.length} rows. {readyRowCount} ready to import.
        </p>
      </div>

      {/* Filter Tabs - Compressed */}
      <div className="flex-shrink-0 mb-3 flex items-center gap-2">
        <Button
          variant={filterView === 'all' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilterView('all')}
          className="h-8"
        >
          All ({parsedData.length})
        </Button>
        <Button
          variant={filterView === 'ready' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilterView('ready')}
          className="h-8"
        >
          <CheckCircle className="h-3 w-3 mr-1.5" />
          Ready ({readyRowCount})
        </Button>
        {errorRowCount > 0 && (
          <Button
            variant={filterView === 'errors' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterView('errors')}
            className="h-8 text-red-600 border-red-300 hover:bg-red-50"
          >
            <AlertCircle className="h-3 w-3 mr-1.5" />
            Errors ({errorRowCount})
          </Button>
        )}
        {duplicateRowCount > 0 && (
          <Button
            variant={filterView === 'duplicates' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterView('duplicates')}
            className="h-8 text-orange-600 border-orange-300 hover:bg-orange-50"
          >
            Duplicates ({duplicateRowCount})
          </Button>
        )}
      </div>

      {/* Data Grid - Scrollable */}
      <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0 z-10 shadow-sm">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-xs w-12 bg-gray-100 dark:bg-gray-800 sticky left-0 z-20 border-r border-gray-200 dark:border-gray-700">
                #
              </th>
              {displayColumns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-left font-medium text-xs border-r border-gray-200 dark:border-gray-700"
                  style={{ minWidth: col.width }}
                >
                  {col.label}
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium text-xs w-24">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {filteredRows.map(({ row, index }) => {
              const hasError = rowErrors.has(index);
              const isDuplicate = duplicates.some((d) => d.rowIndex === index);
              const cellErrors = rowErrors.get(index) || [];

              return (
                <tr
                  key={index}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-900 ${
                    hasError ? 'bg-red-50/30 dark:bg-red-950/10' : isDuplicate ? 'bg-orange-50/30 dark:bg-orange-950/10' : ''
                  }`}
                >
                  <td className={`px-3 py-2 text-xs text-muted-foreground bg-gray-50 dark:bg-gray-900 sticky left-0 z-10 border-r border-gray-200 dark:border-gray-700 ${
                    hasError ? 'bg-red-50 dark:bg-red-950/20' : isDuplicate ? 'bg-orange-50 dark:bg-orange-950/20' : ''
                  }`}>
                    {index + 1}
                  </td>
                    {displayColumns.map((col) => {
                      const cellError = cellErrors.find((e) => e.field === col.key);
                      const cellValue = row[col.key] || '';

                      return (
                        <td
                          key={col.key}
                          className={`px-3 py-2 border-r border-gray-200 dark:border-gray-700 ${
                            cellError ? 'bg-red-50/30 dark:bg-red-950/10' : ''
                          }`}
                        >
                          {cellError ? (
                            cellError.suggestion ? (
                              // Has suggestion - show magic wand icon + autocomplete
                              <div className="flex items-center gap-1 group">
                                <div
                                  contentEditable
                                  suppressContentEditableWarning
                                  className="flex-1 text-xs text-red-600 dark:text-red-400 outline-none cursor-text min-h-[20px] border-b border-red-300 border-dashed pr-6"
                                  title={`${cellError.error}: ${cellError.suggestion}`}
                                  onFocus={(e) => {
                                    // Pre-fill with suggestion and select it
                                    e.currentTarget.textContent = cellError.suggestion!;
                                    const range = document.createRange();
                                    const sel = window.getSelection();
                                    range.selectNodeContents(e.currentTarget);
                                    sel?.removeAllRanges();
                                    sel?.addRange(range);
                                  }}
                                  onBlur={(e) => {
                                    const newValue = e.currentTarget.textContent || '';
                                    if (newValue !== cellValue && newValue !== '') {
                                      handleCellEdit(index, col.key, newValue);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      const newValue = e.currentTarget.textContent || '';
                                      if (newValue !== cellValue && newValue !== '') {
                                        handleCellEdit(index, col.key, newValue);
                                      }
                                      e.currentTarget.blur();
                                    } else if (e.key === 'Escape') {
                                      e.currentTarget.textContent = cellValue;
                                      e.currentTarget.blur();
                                    }
                                  }}
                                >
                                  {cellValue || ''}
                                </div>
                                <button
                                  onClick={() => handleCellEdit(index, col.key, cellError.suggestion!)}
                                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-green-100 dark:hover:bg-green-900 rounded"
                                  title={`Apply suggestion: ${cellError.suggestion}`}
                                >
                                  <Wand2 className="h-3.5 w-3.5 text-green-600" />
                                </button>
                              </div>
                            ) : (
                              // No suggestion - inline editable like Excel
                              <div
                                contentEditable
                                suppressContentEditableWarning
                                className="text-xs text-red-600 dark:text-red-400 outline-none cursor-text min-h-[20px] border-b border-red-300 border-dashed"
                                title={cellError.error}
                                onBlur={(e) => {
                                  const newValue = e.currentTarget.textContent || '';
                                  if (newValue !== cellValue) {
                                    handleCellEdit(index, col.key, newValue);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const newValue = e.currentTarget.textContent || '';
                                    handleCellEdit(index, col.key, newValue);
                                    e.currentTarget.blur();
                                  } else if (e.key === 'Escape') {
                                    e.currentTarget.textContent = cellValue;
                                    e.currentTarget.blur();
                                  }
                                }}
                              >
                                {cellValue || ''}
                              </div>
                            )
                          ) : (
                            // No error - still editable for fixing typos
                            <div
                              contentEditable
                              suppressContentEditableWarning
                              className="text-xs outline-none cursor-text min-h-[20px] hover:bg-gray-100 dark:hover:bg-gray-800 px-1 -mx-1 rounded transition-colors"
                              onBlur={(e) => {
                                const newValue = e.currentTarget.textContent || '';
                                if (newValue !== cellValue) {
                                  handleCellEdit(index, col.key, newValue);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const newValue = e.currentTarget.textContent || '';
                                  handleCellEdit(index, col.key, newValue);
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  e.currentTarget.textContent = cellValue;
                                  e.currentTarget.blur();
                                }
                              }}
                            >
                              {cellValue}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      {hasError ? (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600">
                          <AlertCircle className="h-3 w-3" /> {cellErrors.length} error(s)
                        </span>
                      ) : isDuplicate ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                              <AlertCircle className="h-3 w-3" /> Duplicate
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80">
                            <div className="space-y-3">
                              <p className="text-sm font-semibold">Duplicate Driver Found</p>
                              <p className="text-xs text-muted-foreground">
                                A driver with the same{' '}
                                {duplicates.find((d) => d.rowIndex === index)?.matchedOn} already exists.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full"
                                onClick={() => {
                                  handleSkipDuplicate(index);
                                  document.body.click();
                                }}
                              >
                                Skip This Row
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle className="h-3 w-3" /> Ready
                        </span>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Compact Tips Bar */}
      <div className="flex-shrink-0 mt-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-2">
        <p className="text-xs text-blue-800 dark:text-blue-200 flex items-center gap-4 flex-wrap">
          <span className="font-medium text-blue-900 dark:text-blue-100">💡 Tips:</span>
          <span>Click any cell to edit</span>
          <span className="flex items-center gap-1">
            <Wand2 className="h-3 w-3 text-green-600" /> Quick-fix suggestions
          </span>
          <span>Enter to save • Esc to cancel</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-orange-100 mr-1 rounded"></span> Duplicate
          </span>
        </p>
      </div>

      {/* Import Button */}
      <div className="flex-shrink-0 mt-3 flex justify-end">
        <Button onClick={handleImport} disabled={isImporting || validRows.length === 0} size="lg">
          {isImporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>Import {validRows.length} Driver{validRows.length !== 1 ? 's' : ''}</>
          )}
        </Button>
      </div>
    </div>
  );
}
