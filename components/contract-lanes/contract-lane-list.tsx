'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search, Upload, Trash2 } from 'lucide-react';
import { Doc, Id } from '@/convex/_generated/dataModel';
import { ContractLaneListItem } from './contract-lane-list-item';
import { ContractLaneListHeader } from './contract-lane-list-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ImportCsvDialog } from './import-csv-dialog';

type ContractLane = Doc<'contractLanes'>;

interface ContractLaneListProps {
  data: ContractLane[];
  customerId: Id<'customers'>;
  workosOrgId: string;
  userId: string;
  onCreateClick?: () => void;
  onDelete?: (id: string) => Promise<void>;
}

export function ContractLaneList({ data, customerId, workosOrgId, userId, onCreateClick, onDelete }: ContractLaneListProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState<string>('all');
  const [selectedLanes, setSelectedLanes] = React.useState<Set<string>>(new Set());
  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Filter contract lanes based on search query and status
  const filteredLanes = React.useMemo(() => {
    let filtered = data;

    // Apply search filter (HCR, Trip Number, Contract Name)
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (lane) =>
          (lane.hcr?.toLowerCase().includes(query) || false) ||
          (lane.tripNumber?.toLowerCase().includes(query) || false) ||
          lane.contractName.toLowerCase().includes(query),
      );
    }

    // Apply status filter
    if (filterStatus === 'deleted') {
      filtered = filtered.filter((lane) => lane.isDeleted === true);
    } else if (filterStatus === 'active') {
      filtered = filtered.filter((lane) => (lane.isActive ?? true) && !lane.isDeleted);
    } else if (filterStatus === 'inactive') {
      filtered = filtered.filter((lane) => !(lane.isActive ?? true) && !lane.isDeleted);
    } else if (filterStatus === 'all') {
      filtered = filtered.filter((lane) => !lane.isDeleted);
    }

    return filtered;
  }, [data, searchQuery, filterStatus]);

  // Handle selection
  const handleSelectionChange = (laneId: string, selected: boolean) => {
    setSelectedLanes((prev) => {
      const newSet = new Set(prev);
      if (selected) {
        newSet.add(laneId);
      } else {
        newSet.delete(laneId);
      }
      return newSet;
    });
  };

  // Handle select all
  const handleSelectAll = () => {
    if (selectedLanes.size === filteredLanes.length) {
      // Deselect all
      setSelectedLanes(new Set());
    } else {
      // Select all
      setSelectedLanes(new Set(filteredLanes.map((lane) => lane._id)));
    }
  };

  // Handle bulk delete
  const handleBulkDelete = async () => {
    if (!onDelete || selectedLanes.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedLanes.size} contract lane${selectedLanes.size !== 1 ? 's' : ''}?`
    );

    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await Promise.all(Array.from(selectedLanes).map((laneId) => onDelete(laneId)));
      setSelectedLanes(new Set());
    } catch (error) {
      console.error('Failed to delete lanes:', error);
      alert('Failed to delete some lanes. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter Tabs */}
      <Tabs value={filterStatus} onValueChange={setFilterStatus} className="w-full">
        <TabsList className="inline-flex h-9 items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="inactive">Inactive</TabsTrigger>
          <TabsTrigger value="deleted">Deleted</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Search and Action Buttons */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by HCR, Trip, or Contract Name..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          {selectedLanes.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {selectedLanes.size} selected
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleBulkDelete}
                disabled={isDeleting}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {isDeleting ? 'Deleting...' : 'Delete Selected'}
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setImportDialogOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button size="sm" onClick={onCreateClick}>
            <Plus className="mr-2 h-4 w-4" />
            Create Contract Lane
          </Button>
        </div>
      </div>

      {/* Table Header with Select All */}
      <ContractLaneListHeader 
        showCheckbox={true}
        allSelected={selectedLanes.size === filteredLanes.length && filteredLanes.length > 0}
        onSelectAll={handleSelectAll}
      />

      {/* Contract Lane List */}
      <div className="space-y-2 overflow-x-auto">
        {filteredLanes.length > 0 ? (
          filteredLanes.map((lane) => (
            <ContractLaneListItem
              key={lane._id}
              lane={lane}
              customerId={customerId}
              isSelected={selectedLanes.has(lane._id)}
              onSelectionChange={handleSelectionChange}
              onDelete={onDelete}
            />
          ))
        ) : (
          <div className="flex items-center justify-center h-64 border border-dashed rounded-lg">
            <div className="text-center">
              <p className="text-muted-foreground mb-2">No contract lanes found</p>
              {searchQuery && (
                <Button variant="link" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Results Count */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <div>
          Showing {filteredLanes.length} of {data.length} contract lane{data.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Import CSV Dialog */}
      <ImportCsvDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        customerId={customerId}
        workosOrgId={workosOrgId}
        userId={userId}
      />
    </div>
  );
}
