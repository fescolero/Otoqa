'use client';

import { useState, useMemo } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';

interface ImportContractLanesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: Id<'laneAnalysisSessions'>;
  organizationId: string;
}

export function ImportContractLanesDialog({
  open,
  onOpenChange,
  sessionId,
  organizationId,
}: ImportContractLanesDialogProps) {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedLaneIds, setSelectedLaneIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  // Get all customers
  const customers = useAuthQuery(api.customers.list, {
    workosOrgId: organizationId,
  });

  // Get contract lanes for selected customer
  const customerLanes = useAuthQuery(
    api.contractLanes.listByCustomer,
    selectedCustomerId
      ? { customerCompanyId: selectedCustomerId as Id<'customers'> }
      : 'skip',
  );

  const importLanes = useMutation(api.laneAnalyzer.importLanesFromContract);

  // Filter lanes by search
  const filteredLanes = useMemo(() => {
    if (!customerLanes) return [];
    if (!searchQuery) return customerLanes;
    const q = searchQuery.toLowerCase();
    return customerLanes.filter(
      (lane: { contractName: string; hcr?: string; tripNumber?: string; stops: Array<{ city: string; state: string }> }) =>
        lane.contractName.toLowerCase().includes(q) ||
        lane.hcr?.toLowerCase().includes(q) ||
        lane.tripNumber?.toLowerCase().includes(q) ||
        lane.stops.some((s) => s.city.toLowerCase().includes(q) || s.state.toLowerCase().includes(q)),
    );
  }, [customerLanes, searchQuery]);

  const toggleLane = (laneId: string) => {
    setSelectedLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  };

  const selectAll = () => {
    if (!filteredLanes) return;
    setSelectedLaneIds(new Set(filteredLanes.map((l: { _id: string }) => l._id)));
  };

  const deselectAll = () => {
    setSelectedLaneIds(new Set());
  };

  const handleImport = async () => {
    if (selectedLaneIds.size === 0) {
      toast.error('Select at least one lane to import');
      return;
    }

    setIsImporting(true);
    try {
      const imported = await importLanes({
        sessionId,
        workosOrgId: organizationId,
        contractLaneIds: Array.from(selectedLaneIds) as Id<'contractLanes'>[],
      });
      toast.success(`Imported ${imported.length} lanes`);
      setSelectedLaneIds(new Set());
      onOpenChange(false);
    } catch (error) {
      toast.error('Failed to import lanes');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import from Contract Lanes</DialogTitle>
          <DialogDescription>
            Select a customer and choose which contract lanes to import into this analysis session.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* Customer Selector */}
          <div className="grid gap-2">
            <Label>Customer</Label>
            <Select
              value={selectedCustomerId}
              onValueChange={(v) => {
                setSelectedCustomerId(v);
                setSelectedLaneIds(new Set());
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a customer..." />
              </SelectTrigger>
              <SelectContent>
                {customers?.map((c) => (
                  <SelectItem key={c._id} value={c._id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Lane List */}
          {selectedCustomerId && (
            <>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search lanes..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-8"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={deselectAll}>
                  Clear
                </Button>
              </div>

              <div className="border rounded-md overflow-y-auto flex-1 min-h-0 max-h-[40vh]">
                {!filteredLanes?.length ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {customerLanes === undefined ? 'Loading...' : 'No contract lanes found'}
                  </div>
                ) : (
                  <div className="divide-y">
                    {filteredLanes.map((lane: {
                      _id: string;
                      contractName: string;
                      hcr?: string;
                      tripNumber?: string;
                      miles?: number;
                      rate: number;
                      rateType: string;
                      equipmentClass?: string;
                      isActive?: boolean;
                      stops: Array<{ city: string; state: string; stopType: string }>;
                    }) => {
                      const firstStop = lane.stops[0];
                      const lastStop = lane.stops[lane.stops.length - 1];
                      return (
                        <label
                          key={lane._id}
                          className="flex items-center gap-3 p-3 hover:bg-accent cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedLaneIds.has(lane._id)}
                            onCheckedChange={() => toggleLane(lane._id)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm truncate">
                              {lane.contractName}
                              {lane.hcr && (
                                <span className="text-muted-foreground ml-2">
                                  HCR: {lane.hcr}
                                  {lane.tripNumber && ` / Trip: ${lane.tripNumber}`}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {firstStop?.city}, {firstStop?.state} → {lastStop?.city}, {lastStop?.state}
                              {lane.miles && ` • ${lane.miles} mi`}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {lane.equipmentClass && (
                              <Badge variant="outline" className="text-xs">{lane.equipmentClass}</Badge>
                            )}
                            <span className="text-sm tabular-nums">
                              ${lane.rate} {lane.rateType === 'Per Mile' ? '/mi' : ''}
                            </span>
                            {lane.isActive === false && (
                              <Badge variant="secondary" className="text-xs">Inactive</Badge>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="text-sm text-muted-foreground">
                {selectedLaneIds.size} of {filteredLanes?.length ?? 0} lanes selected
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={selectedLaneIds.size === 0 || isImporting}
          >
            {isImporting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Import {selectedLaneIds.size} Lane{selectedLaneIds.size !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
