# Driver Settlement Engine - UX/UI Implementation Guide

## 🎯 UX Concept Review: ⭐⭐⭐⭐⭐ Excellent

Your concept is **exactly right** for a power-user accounting tool. The "interactive worksheet" approach is perfect because:

✅ **Mirrors Real-World Workflow** - Accountants audit settlements, not just view them
✅ **Evidence-Based Design** - POD/receipts visible alongside numbers
✅ **Inline Editing** - Hold/add adjustments without context switching
✅ **Variance Detection** - Red flags appear where the accountant is looking
✅ **Batch Efficiency** - Process 50 drivers in one sitting

## 📋 Minor Improvements Recommended

### 1. Add "Unassigned Payables" Queue
**Why:** Some payables may not have a `settlementId` yet. Show these in a separate tab.

**Location:** Add a 5th tab: `All | Draft | Pending | Approved | Paid | **Unassigned**`

**Behavior:** Shows payables where `settlementId === null`, grouped by driver. Click "Generate Statement" to auto-create.

### 2. Add "Batch Generate" Feature
**Why:** Accountants need to create statements for 20+ drivers at once on payday.

**UI:** Button in main dashboard: `Generate All Statements` → Opens wizard:
- Date range picker (e.g., "Last Week")
- Driver multi-select or "All Drivers"
- Toggle: "Include held items from previous periods"
- Shows preview: "Will create 23 statements totaling $127,450"

### 3. Variance Threshold Indicators
**Why:** 7% variance might be okay, but 15% needs attention.

**Current Plan:** Color-coded (5% = yellow, 10% = red)
**Enhancement:** Add tooltip on hover showing: `Driver: 1,200 mi | System: 1,050 mi | Detour reported: Chicago traffic`

### 4. Receipt Upload Progress
**Why:** When an accountant uploads 10 receipts, show inline confirmation.

**UI:** After upload, show green checkmark next to "Receipt uploaded" with timestamp.

---

## 🏗️ Component Architecture (Using Your Existing Patterns)

### File Structure
```
app/(app)/settlements/
  ├── page.tsx                          # Main dashboard (wrapper)
  └── _components/
      ├── settlements-dashboard.tsx     # Command center (like invoices-dashboard.tsx)
      ├── settlement-worksheet-sheet.tsx # Interactive drawer (like invoice-preview-sheet.tsx)
      ├── settlement-status-badge.tsx   # Status pills (like invoice-status-badge.tsx)
      ├── settlement-filter-bar.tsx     # Filters (like invoice-filter-bar.tsx)
      ├── floating-action-bar.tsx       # Reuse existing
      ├── virtualized-settlement-table.tsx # High-density table
      ├── payables-list.tsx             # Grouped payables (NEW)
      ├── audit-alert-bar.tsx           # Variance warnings (NEW)
      ├── quick-add-menu.tsx            # Template buttons (NEW)
      └── evidence-panel.tsx            # POD/stops viewer (NEW)
```

---

## 📐 Layout Specifications

### Main Dashboard (settlements-dashboard.tsx)
**Reference:** `app/(app)/invoices/_components/invoices-dashboard.tsx`

```tsx
// Exact pattern from invoices dashboard
<div className="flex flex-col h-screen">
  {/* Header */}
  <div className="h-14 border-b bg-background px-6 flex items-center justify-between">
    <h1>Driver Settlements</h1>
    <Button>Generate Statements</Button>
  </div>

  {/* Tabs */}
  <Tabs value={activeTab} onValueChange={setActiveTab}>
    <TabsList>
      <TabsTrigger value="all">All ({counts?.all || 0})</TabsTrigger>
      <TabsTrigger value="draft">Draft ({counts?.draft || 0})</TabsTrigger>
      <TabsTrigger value="pending">Pending ({counts?.pending || 0})</TabsTrigger>
      <TabsTrigger value="approved">Approved ({counts?.approved || 0})</TabsTrigger>
      <TabsTrigger value="paid">Paid ({counts?.paid || 0})</TabsTrigger>
    </TabsList>
  </Tabs>

  {/* Filter Bar */}
  <SettlementFilterBar filters={filters} onFilterChange={setFilters} />

  {/* Floating Action Bar (for bulk operations) */}
  <FloatingActionBar
    selectedCount={selectedSettlementIds.size}
    onApprove={handleBulkApprove}
    onVoid={handleBulkVoid}
    onDownload={handleBulkDownload}
    onClearSelection={() => setSelectedSettlementIds(new Set())}
  />

  {/* High-Density Table */}
  <VirtualizedSettlementTable
    settlements={filteredSettlements}
    selectedIds={selectedSettlementIds}
    onRowClick={(id) => setPreviewSettlementId(id)}
    onSelectRow={handleSelectRow}
  />

  {/* Interactive Worksheet Drawer */}
  <SettlementWorksheetSheet
    settlementId={previewSettlementId}
    isOpen={!!previewSettlementId}
    onClose={() => setPreviewSettlementId(null)}
  />
</div>
```

---

## 🎨 Component Specifications

### 1. Settlement Status Badge
**Reference:** `app/(app)/invoices/_components/invoice-status-badge.tsx` (lines 1-70)

```tsx
// settlement-status-badge.tsx
export function SettlementStatusBadge({ status }: { status: string }) {
  const getStyles = () => {
    switch (status) {
      case 'DRAFT':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-200';
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300 border-yellow-200';
      case 'APPROVED':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 border-blue-200';
      case 'PAID':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300 border-green-200';
      case 'VOID':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 border-red-200';
    }
  };

  return (
    <Badge variant="outline" className={cn('rounded-full px-3 py-0.5 text-[10px] font-medium', getStyles())}>
      {status}
    </Badge>
  );
}
```

**Colors (Exact same as Invoices):**
- DRAFT: Gray (same as Invoice DRAFT)
- PENDING: Yellow (same as Invoice PENDING_PAYMENT)
- APPROVED: Blue (same as Invoice BILLED)
- PAID: Green (same as Invoice PAID)
- VOID: Red (same as Invoice VOID)

---

### 2. Virtualized Settlement Table
**Reference:** `app/(app)/invoices/_components/virtualized-invoice-table.tsx` (lines 1-203)

```tsx
// virtualized-settlement-table.tsx
interface Settlement {
  _id: Id<'driverSettlements'>;
  statementNumber: string;
  driverName: string; // Enriched
  periodStart: number;
  periodEnd: number;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID';
  grossTotal?: number;
  totalLoads?: number;
  hasWarnings: boolean; // Calculated
}

export function VirtualizedSettlementTable({
  settlements,
  selectedIds,
  onRowClick,
  onSelectRow,
}: Props) {
  // Exact same virtualization pattern as invoices
  const rowVirtualizer = useVirtualizer({
    count: settlements.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Same 48px row height
    overscan: 10,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Fixed Header */}
      <div className="flex-shrink-0 border-b bg-background">
        <div className="flex items-center h-10 w-full">
          <div className="px-2 w-12"><Checkbox /></div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Statement #</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Driver</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Period</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Gross Pay</div>
          <div className="px-4 w-12"></div>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const settlement = settlements[virtualRow.index];
            return (
              <div
                key={settlement._id}
                className="absolute top-0 left-0 w-full h-[48px] cursor-pointer hover:bg-slate-50/80 border-b flex items-center"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => onRowClick(settlement._id)}
              >
                <div className="px-2 w-12"><Checkbox /></div>
                <div className="px-4 flex-1 text-sm font-mono">{settlement.statementNumber}</div>
                <div className="px-4 flex-1 text-sm">{settlement.driverName}</div>
                <div className="px-4 flex-1 text-sm">
                  {formatDateRange(settlement.periodStart, settlement.periodEnd)}
                </div>
                <div className="px-4 flex-1">
                  <SettlementStatusBadge status={settlement.status} />
                </div>
                <div className="px-4 flex-1 text-sm font-medium">
                  {formatCurrency(settlement.grossTotal || 0)}
                </div>
                <div className="px-4 w-12">
                  {settlement.hasWarnings && (
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

**Key Details:**
- Same 48px row height as Invoices
- Same hover effect: `hover:bg-slate-50/80`
- Same border: `border-b`
- Same typography: `text-sm font-medium` for numbers, `font-mono` for IDs

---

### 3. Settlement Worksheet Sheet (The Interactive Drawer)
**Reference:** `app/(app)/invoices/_components/invoice-preview-sheet.tsx` (lines 1-283)

```tsx
// settlement-worksheet-sheet.tsx
export function SettlementWorksheetSheet({
  settlementId,
  isOpen,
  onClose,
}: Props) {
  const settlement = useQuery(api.driverSettlements.getSettlementDetails, 
    settlementId ? { settlementId } : "skip"
  );

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent 
        className="w-full sm:max-w-6xl p-0"  // WIDER than invoice sheet (70% instead of 50%)
      >
        <div className="h-full flex flex-col">
          {/* Toolbar (same pattern as invoice-preview-sheet.tsx line 179-258) */}
          <div className="h-14 border-b bg-background flex items-center justify-between px-6">
            <SheetTitle>
              Settlement Worksheet
              <span className="text-muted-foreground ml-2 font-mono">
                {settlement?.statementNumber}
              </span>
            </SheetTitle>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handlePrint}>
                <Printer className="w-4 h-4 mr-2" />
                Print
              </Button>
              <Button size="sm" onClick={handleApprove} disabled={settlement?.status !== 'DRAFT'}>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Approve
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content: 70/30 Split */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left Panel: The Worksheet (70%) */}
            <div className="flex-1 flex flex-col overflow-hidden border-r">
              {/* Summary Cards */}
              <div className="p-6 border-b bg-slate-50/30">
                <div className="grid grid-cols-4 gap-4">
                  <InsightCard 
                    label="Gross Pay" 
                    value={formatCurrency(settlement?.summary.totalGross || 0)} 
                    icon={<DollarSign />}
                  />
                  <InsightCard 
                    label="Total Miles" 
                    value={settlement?.summary.totalMiles || 0} 
                    icon={<Truck />}
                  />
                  <InsightCard 
                    label="Load Count" 
                    value={settlement?.summary.uniqueLoads || 0} 
                    icon={<Package />}
                  />
                  <InsightCard 
                    label="Avg $/Mile" 
                    value={formatCurrency(settlement?.summary.averageRatePerMile || 0)} 
                    icon={<TrendingUp />}
                  />
                </div>
              </div>

              {/* Audit Alert Bar */}
              <AuditAlertBar auditFlags={settlement?.auditFlags} />

              {/* Payables List (Grouped) */}
              <div className="flex-1 overflow-auto px-6">
                <PayablesList 
                  payables={settlement?.payables || []}
                  onHoldLoad={handleHoldLoad}
                  onViewLoad={handleViewLoad}
                />
              </div>

              {/* Quick Add Section */}
              <div className="border-t p-4 bg-background">
                <QuickAddMenu 
                  settlementId={settlementId}
                  onAddAdjustment={handleAddAdjustment}
                />
              </div>
            </div>

            {/* Right Panel: Evidence Panel (30%) */}
            <div className="w-80 flex flex-col overflow-hidden bg-slate-50/30">
              <EvidencePanel 
                selectedLoad={selectedLoad}
                onUploadPOD={handleUploadPOD}
                onUploadReceipt={handleUploadReceipt}
              />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

**Key Differences from Invoice Sheet:**
- **Width:** `sm:max-w-6xl` (wider) vs `sm:max-w-3xl` (invoice)
- **Layout:** 70/30 split (worksheet + evidence) vs single column (invoice)
- **Interactive:** Inline editing vs static preview

---

### 4. Audit Alert Bar (NEW Component)

```tsx
// audit-alert-bar.tsx
export function AuditAlertBar({ auditFlags }: { auditFlags: AuditFlags }) {
  const [activeFilter, setActiveFilter] = useState<'all' | 'pods' | 'variances' | 'receipts'>('all');

  const alerts = [
    {
      key: 'pods',
      icon: <FileText className="w-4 h-4" />,
      count: auditFlags.missingPods.length,
      label: 'Missing PODs',
      color: 'text-red-600 bg-red-50 border-red-200',
    },
    {
      key: 'variances',
      icon: <AlertTriangle className="w-4 h-4" />,
      count: auditFlags.mileageVariances.length,
      label: 'Mileage Variances',
      color: 'text-amber-600 bg-amber-50 border-amber-200',
    },
    {
      key: 'receipts',
      icon: <Paperclip className="w-4 h-4" />,
      count: auditFlags.missingReceipts.length,
      label: 'Missing Receipts',
      color: 'text-orange-600 bg-orange-50 border-orange-200',
    },
  ];

  if (alerts.every(a => a.count === 0)) {
    return (
      <div className="px-6 py-3 bg-green-50/30 border-b border-green-200 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600" />
        <span className="text-sm font-medium text-green-900">No issues found</span>
      </div>
    );
  }

  return (
    <div className="px-6 py-3 bg-background border-b flex items-center gap-2">
      <span className="text-sm font-medium text-muted-foreground mr-2">Audit Alerts:</span>
      {alerts.map((alert) => (
        alert.count > 0 && (
          <Button
            key={alert.key}
            variant="outline"
            size="sm"
            className={cn(
              'h-8 px-3 border',
              activeFilter === alert.key ? alert.color : 'hover:bg-slate-50'
            )}
            onClick={() => setActiveFilter(activeFilter === alert.key ? 'all' : alert.key as any)}
          >
            {alert.icon}
            <span className="ml-2 font-medium">{alert.count}</span>
            <span className="ml-1 text-xs">{alert.label}</span>
          </Button>
        )
      ))}
    </div>
  );
}
```

**Behavior:**
- Clicking an alert button filters the payables list below
- "No issues" shows green checkmark (positive reinforcement)
- Counts update in real-time as issues are resolved

---

### 5. Payables List (Grouped by Load)

```tsx
// payables-list.tsx
export function PayablesList({ payables, onHoldLoad, onViewLoad }: Props) {
  // Group payables by loadId
  const groupedPayables = useMemo(() => {
    const groups = new Map<string, Payable[]>();
    
    payables.forEach((payable) => {
      const key = payable.loadId || 'standalone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(payable);
    });
    
    return Array.from(groups.entries());
  }, [payables]);

  return (
    <div className="space-y-4 py-4">
      {groupedPayables.map(([loadId, items]) => {
        const isStandalone = loadId === 'standalone';
        const firstItem = items[0];
        const groupTotal = items.reduce((sum, p) => sum + p.totalAmount, 0);

        return (
          <Card key={loadId} className="border">
            {/* Load Header */}
            <div className="px-4 py-3 bg-slate-50/50 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                {!isStandalone && (
                  <>
                    <Button 
                      variant="ghost" 
                      size="sm"
                      onClick={() => onViewLoad(loadId)}
                      className="font-mono text-sm"
                    >
                      {firstItem.loadInternalId}
                    </Button>
                    <Badge variant="outline" className="text-xs">
                      {firstItem.loadOrderNumber}
                    </Badge>
                  </>
                )}
                {isStandalone && (
                  <span className="text-sm font-medium text-muted-foreground">
                    Standalone Adjustments
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">
                  {formatCurrency(groupTotal)}
                </span>
                {!isStandalone && (
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => onHoldLoad(loadId)}
                  >
                    <Pause className="w-4 h-4 mr-2" />
                    Hold
                  </Button>
                )}
              </div>
            </div>

            {/* Payable Line Items */}
            <Table>
              <TableBody>
                {items.map((payable) => (
                  <TableRow key={payable._id} className="hover:bg-slate-50/50">
                    <TableCell className="w-12">
                      {payable.sourceType === 'MANUAL' ? (
                        <Badge variant="secondary" className="text-[10px]">MANUAL</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">SYSTEM</Badge>
                      )}
                    </TableCell>
                    <TableCell className="flex-1">{payable.description}</TableCell>
                    <TableCell className="w-24 text-right">{payable.quantity}</TableCell>
                    <TableCell className="w-24 text-right">{formatCurrency(payable.rate)}</TableCell>
                    <TableCell className="w-32 text-right font-medium">
                      {formatCurrency(payable.totalAmount)}
                    </TableCell>
                    <TableCell className="w-12">
                      {payable.warningMessage && (
                        <Tooltip>
                          <TooltipTrigger>
                            <AlertCircle className="w-4 h-4 text-amber-500" />
                          </TooltipTrigger>
                          <TooltipContent>{payable.warningMessage}</TooltipContent>
                        </Tooltip>
                      )}
                      {payable.receiptStorageId && (
                        <Paperclip className="w-4 h-4 text-green-600" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        );
      })}
    </div>
  );
}
```

**Visual Hierarchy:**
1. Load groups in Cards (elevation)
2. Load header with ID, order #, and Hold button
3. Line items in compact table
4. Source badges (SYSTEM vs MANUAL)
5. Warning icons with tooltips

---

### 6. Quick Add Menu (Template Buttons)

```tsx
// quick-add-menu.tsx
export function QuickAddMenu({ settlementId, onAddAdjustment }: Props) {
  const templates = useQuery(api.manualTemplates.listTemplates, {
    workosOrgId: organizationId,
    profileType: 'DRIVER',
  });

  const commonTypes = useQuery(api.manualTemplates.getCommonAdjustmentTypes, {});

  const [customAmount, setCustomAmount] = useState('');
  const [customDescription, setCustomDescription] = useState('');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Quick Add Adjustment</h3>
        <Button variant="ghost" size="sm">
          <Settings className="w-4 h-4" />
        </Button>
      </div>

      {/* Template Chips */}
      <div className="flex flex-wrap gap-2">
        {templates?.map((template) => (
          <Button
            key={template._id}
            variant="outline"
            size="sm"
            className="h-8 px-3 hover:bg-blue-50 hover:border-blue-300"
            onClick={() => onAddAdjustment({
              description: template.name,
              amount: template.rateAmount,
            })}
          >
            <Plus className="w-3 h-3 mr-1.5" />
            {template.description}
          </Button>
        ))}
      </div>

      {/* Custom Addition */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs">Description</Label>
          <Input
            placeholder="e.g., Referral Bonus"
            value={customDescription}
            onChange={(e) => setCustomDescription(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="w-32">
          <Label className="text-xs">Amount</Label>
          <Input
            type="number"
            placeholder="0.00"
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            className="h-9"
          />
        </div>
        <Button 
          size="sm" 
          className="h-9"
          onClick={() => {
            onAddAdjustment({
              description: customDescription,
              amount: parseFloat(customAmount),
            });
            setCustomDescription('');
            setCustomAmount('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
```

**Key Features:**
- Template chips from `rateRules` (org-configurable)
- One-click add: `+ Layover ($150)`
- Custom input for ad-hoc adjustments
- Hover effect: `hover:bg-blue-50` (same as table rows)

---

### 7. Evidence Panel (POD/Stops Viewer)

```tsx
// evidence-panel.tsx
export function EvidencePanel({ selectedLoad, onUploadPOD, onUploadReceipt }: Props) {
  if (!selectedLoad) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <FileText className="w-12 h-12 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Select a load to view evidence</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b">
        <h3 className="text-sm font-semibold">{selectedLoad.loadInternalId}</h3>
        <p className="text-xs text-muted-foreground">{selectedLoad.orderNumber}</p>
      </div>

      {/* Stops Timeline */}
      <div className="p-4 border-b">
        <Label className="text-xs font-medium">Stops</Label>
        <div className="mt-2 space-y-2">
          {selectedLoad.stops.map((stop, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-xs font-medium">
                {index + 1}
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium">{stop.city}, {stop.state}</p>
                <p className="text-xs text-muted-foreground">{formatTime(stop.windowBeginTime)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* POD Section */}
      <div className="p-4 border-b">
        <Label className="text-xs font-medium">Proof of Delivery</Label>
        {selectedLoad.podStorageId ? (
          <div className="mt-2 border rounded-lg overflow-hidden">
            <img 
              src={selectedLoad.podUrl} 
              alt="POD" 
              className="w-full h-auto"
            />
          </div>
        ) : (
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onUploadPOD(selectedLoad._id)}
            >
              <Upload className="w-4 h-4 mr-2" />
              Upload POD
            </Button>
          </div>
        )}
      </div>

      {/* Mileage Comparison */}
      <div className="p-4">
        <Label className="text-xs font-medium">Mileage</Label>
        <div className="mt-2 space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">System:</span>
            <span className="font-mono">{selectedLoad.effectiveMiles} mi</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Driver:</span>
            <span className="font-mono">{selectedLoad.driverMiles} mi</span>
          </div>
          {selectedLoad.variance && (
            <div className={cn(
              "flex justify-between text-xs font-medium",
              selectedLoad.variance > 10 ? "text-red-600" : "text-amber-600"
            )}>
              <span>Variance:</span>
              <span>{selectedLoad.variance.toFixed(1)}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## 🎨 Design Tokens (Extract from Existing)

### Typography
```tsx
// From invoice-preview-sheet.tsx and virtualized-invoice-table.tsx
const typography = {
  statementNumber: 'font-mono text-sm',           // Same as invoice number
  driverName: 'text-sm font-medium',              // Same as customer name
  money: 'text-sm font-semibold',                 // Same as invoice amount
  muted: 'text-xs text-muted-foreground',         // Same as metadata
  heading: 'text-sm font-medium',                 // Same as table headers
};
```

### Colors
```tsx
// From invoice-status-badge.tsx
const colors = {
  draft: 'bg-gray-100 text-gray-800 border-gray-200',
  pending: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  approved: 'bg-blue-100 text-blue-800 border-blue-200',
  paid: 'bg-green-100 text-green-800 border-green-200',
  void: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-amber-50 text-amber-600 border-amber-200',
  error: 'bg-red-50 text-red-600 border-red-200',
};
```

### Spacing & Borders
```tsx
// From virtualized-invoice-table.tsx
const layout = {
  rowHeight: '48px',                              // Same as invoice rows
  borderBottom: 'border-b',                       // Same 1px border
  hover: 'hover:bg-slate-50/80',                  // Same hover effect
  padding: 'px-4',                                // Same cell padding
  headerHeight: 'h-10',                           // Same header height
};
```

---

## 🚀 Implementation Sequence

### Phase 1: Foundation (2 hours)
1. Create file structure
2. Copy & adapt `InvoiceStatusBadge` → `SettlementStatusBadge`
3. Copy & adapt `VirtualizedInvoiceTable` → `VirtualizedSettlementTable`
4. Create main dashboard wrapper

### Phase 2: Interactive Drawer (4 hours)
1. Copy & adapt `InvoicePreviewSheet` → `SettlementWorksheetSheet`
2. Build `PayablesList` (grouped table)
3. Build `AuditAlertBar` (variance warnings)
4. Build `QuickAddMenu` (template chips)

### Phase 3: Evidence Panel (2 hours)
1. Build `EvidencePanel` (POD viewer)
2. Integrate file upload
3. Add mileage comparison

### Phase 4: Workflows (3 hours)
1. Hold/release mutations
2. Approval workflow
3. Batch generation wizard

### Total: ~11 hours

---

## 📝 Component Reuse Checklist

- ✅ **Badge** - Use existing `<Badge>` from shadcn
- ✅ **Button** - Use existing `<Button>` from shadcn
- ✅ **Sheet** - Use existing `<Sheet>` (same as Invoice preview)
- ✅ **Table** - Use existing `<Table>` from shadcn
- ✅ **Checkbox** - Use existing `<Checkbox>` (same as Invoice multi-select)
- ✅ **Tabs** - Use existing `<Tabs>` (same as Invoice tabs)
- ✅ **Card** - Use existing `<Card>` from shadcn
- ✅ **FloatingActionBar** - Reuse exact component (already perfect)
- ✅ **Virtualization** - Use `@tanstack/react-virtual` (same setup)

---

## 🎯 Success Metrics

**Efficiency:**
- Process 50 settlements in < 2 hours
- Average time per settlement: < 2 minutes
- Zero context switching (everything in drawer)

**Accuracy:**
- 100% variance detection
- 100% POD verification before approval
- Zero post-approval edits

**User Experience:**
- Keyboard navigation (↑/↓ for rows, ←/→ for drawer nav)
- Inline editing (no popups/modals except confirmations)
- Real-time totals update

---

## ✨ Final Notes
4
Your UX concept is **production-ready**. The only additions I recommend are:

1. **Unassigned Payables Queue** - Critical for week-end reconciliation
2. **Batch Generation Wizard** - Save hours on payday
3. **Variance Tooltips** - Helps accountants make judgment calls
4. **Receipt Upload Progress** - Visual confirmation

The architecture leverages your existing Invoice components, so implementation will be fast and visually consistent. The interactive drawer is the star feature—it transforms a "view-only" document into an "audit workstation."

**Estimated Timeline:** 2-3 days for full implementation including testing.

