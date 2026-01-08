'use client';

import { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, ArrowUpDown } from 'lucide-react';
import { Doc } from '@/convex/_generated/dataModel';

export type Driver = Doc<'drivers'>;

const formatDate = (dateString?: string) => {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

export const columns: ColumnDef<Driver>[] = [
  {
    accessorKey: 'firstName',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="h-8 px-2"
        >
          First Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
  },
  {
    accessorKey: 'lastName',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="h-8 px-2"
        >
          Last Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
  },
  {
    accessorKey: 'email',
    header: 'Email',
    cell: ({ row }) => {
      return <div className="max-w-[200px] truncate">{row.getValue('email')}</div>;
    },
  },
  {
    accessorKey: 'phone',
    header: 'Phone',
  },
  {
    accessorKey: 'licenseNumber',
    header: 'License #',
  },
  {
    accessorKey: 'licenseClass',
    header: 'Class',
  },
  {
    accessorKey: 'licenseExpiration',
    header: 'License Exp.',
    cell: ({ row }) => formatDate(row.getValue('licenseExpiration')),
  },
  {
    accessorKey: 'medicalExpiration',
    header: 'Medical Exp.',
    cell: ({ row }) => formatDate(row.getValue('medicalExpiration')),
  },
  {
    accessorKey: 'employmentStatus',
    header: 'Status',
    cell: ({ row }) => {
      const status = row.getValue('employmentStatus') as string;

      const statusColors = {
        'Active': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
        'Inactive': 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
        'On Leave': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
      };

      return (
        <Badge className={statusColors[status as keyof typeof statusColors] || 'bg-gray-100 text-gray-800'}>
          {status}
        </Badge>
      );
    },
  },
  {
    accessorKey: 'hireDate',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="h-8 px-2"
        >
          Hire Date
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => formatDate(row.getValue('hireDate')),
  },
  {
    id: 'actions',
    cell: ({ row }) => {
      const driver = row.original;

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => navigator.clipboard.writeText(driver._id)}>
              Copy driver ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => (window.location.href = `/fleet/drivers/${driver._id}`)}>
              View details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => (window.location.href = `/fleet/drivers/${driver._id}/edit`)}>
              Edit driver
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive">Delete driver</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
];
