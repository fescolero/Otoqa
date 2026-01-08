# Invoice Preview Integration Guide

## 🎯 How to Add Preview to Your Dashboard

### Step 1: Add State Management

Add this to `invoices-dashboard.tsx` near line 36:

```typescript
// Add to existing useState declarations
const [previewInvoiceId, setPreviewInvoiceId] = useState<Id<"loadInvoices"> | null>(null);
```

### Step 2: Import the Preview Sheet

Add to imports at the top:

```typescript
import { InvoicePreviewSheet } from './invoice-preview-sheet';
import { Eye } from 'lucide-react'; // For the preview icon
```

### Step 3: Add Preview Button to Table Rows

Find the table rows in your tabs (Draft, Pending, Paid) and add a Preview button.

**Example for Draft tab** (around line 250+):

```typescript
<TableRow key={invoice._id}>
  <TableCell>{formatDate(invoice.createdAt)}</TableCell>
  <TableCell className="font-mono">{invoice.load?.orderNumber}</TableCell>
  <TableCell>{invoice.customer?.name}</TableCell>
  <TableCell className="text-right font-mono">
    {formatCurrency(invoice.totalAmount)}
  </TableCell>
  <TableCell>
    <Badge>{invoice.status}</Badge>
  </TableCell>
  <TableCell className="text-right">
    {/* ADD THIS BUTTON */}
    <Button 
      variant="ghost" 
      size="sm"
      onClick={() => setPreviewInvoiceId(invoice._id)}
    >
      <Eye className="h-4 w-4 mr-2" />
      Preview
    </Button>
  </TableCell>
</TableRow>
```

### Step 4: Render the Preview Sheet

Add at the bottom of the component, before the closing `</div>`:

```typescript
return (
  <div className="space-y-4">
    {/* ... existing dashboard code ... */}
    
    {/* Add this at the bottom */}
    <InvoicePreviewSheet 
      invoiceId={previewInvoiceId}
      isOpen={!!previewInvoiceId}
      onClose={() => setPreviewInvoiceId(null)}
    />
    
    {/* Existing FixLaneModal */}
    {selectedGroup && (
      <FixLaneModal 
        group={selectedGroup}
        organizationId={organizationId}
        userId={userId}
        onClose={() => setSelectedGroup(null)}
      />
    )}
  </div>
);
```

---

## 🚀 Complete Integration Example

Here's a complete code snippet you can copy:

```typescript
'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { InvoicePreviewSheet } from './invoice-preview-sheet'; // ADD THIS
import { Eye } from 'lucide-react'; // ADD THIS
// ... other imports ...

export function InvoicesDashboard({ organizationId, userId }: InvoicesDashboardProps) {
  const [activeTab, setActiveTab] = useState<string>('attention');
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<Id<"loadInvoices"> | null>(null); // ADD THIS

  // ... rest of your dashboard code ...

  return (
    <div className="space-y-4">
      {/* ... existing dashboard UI ... */}
      
      {/* Draft Invoices Table */}
      {activeTab === 'draft' && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Order #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead> {/* ADD THIS */}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draftInvoices?.map((invoice) => (
              <TableRow key={invoice._id}>
                <TableCell>{formatDate(invoice.createdAt)}</TableCell>
                <TableCell className="font-mono">{invoice.load?.orderNumber}</TableCell>
                <TableCell>{invoice.customer?.name}</TableCell>
                <TableCell className="text-right font-mono">
                  {formatCurrency(invoice.totalAmount)}
                </TableCell>
                <TableCell>
                  <Badge>{invoice.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {/* ADD THIS BUTTON */}
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => setPreviewInvoiceId(invoice._id)}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Preview
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      
      {/* ADD THIS SHEET COMPONENT */}
      <InvoicePreviewSheet 
        invoiceId={previewInvoiceId}
        isOpen={!!previewInvoiceId}
        onClose={() => setPreviewInvoiceId(null)}
      />
      
      {/* Existing FixLaneModal */}
      {selectedGroup && (
        <FixLaneModal 
          group={selectedGroup}
          organizationId={organizationId}
          userId={userId}
          onClose={() => setSelectedGroup(null)}
        />
      )}
    </div>
  );
}
```

---

## 🎨 User Flow

```
User Journey:
1. User sees invoices list in dashboard
2. Clicks "Preview" button on any invoice
3. Sheet slides in from the right
4. User sees professional invoice preview
5. User can:
   - Print invoice
   - Download PDF
   - Open full-page view
   - Close and return to dashboard
```

---

## 📱 Features You Get

### In the Sheet (Slide-over)
- ✅ Real-time data from Convex
- ✅ Professional invoice layout
- ✅ Print button
- ✅ PDF download button
- ✅ Full-page view link
- ✅ Loading states
- ✅ Responsive design

### In the Full-page View
- ✅ Clean URL: `/invoices/{invoiceId}/preview`
- ✅ Print-optimized layout
- ✅ Back to dashboard button
- ✅ Helpful print instructions
- ✅ Sharable link

---

## 🔧 Customization

### Change Company Details

Edit in both files:
- `invoice-preview-sheet.tsx` (line 38-43)
- `app/invoices/[invoiceId]/preview/page.tsx` (line 24-29)

**Better approach:** Create a config file:

```typescript
// lib/config/company.ts
export const companyDetails = {
  name: process.env.NEXT_PUBLIC_COMPANY_NAME || "Otoqa Logistics Inc.",
  email: process.env.NEXT_PUBLIC_COMPANY_EMAIL || "billing@otoqa.com",
  phone: process.env.NEXT_PUBLIC_COMPANY_PHONE || "+1 (555) 123-4567",
  address: process.env.NEXT_PUBLIC_COMPANY_ADDRESS || 
    "123 Logistics Way\nLos Angeles, CA 90001\nUnited States",
};
```

Then import it:
```typescript
import { companyDetails } from '@/lib/config/company';
```

---

## 🧪 Testing

### Test the Sheet
1. Go to `/invoices`
2. Click "Preview" on any draft invoice
3. Sheet should slide in from right
4. Click "Full Page" button
5. New tab should open with full-page view

### Test the Full Page
1. Go to `/invoices/{any-invoice-id}/preview`
2. Should see clean invoice layout
3. Try printing (Cmd+P / Ctrl+P)
4. Should hide action bar and look professional

---

## 🎯 Next Steps

1. ✅ **Phase 1 Complete**: Presentation components
2. ✅ **Phase 2 Complete**: Integration components (Sheet & Page)
3. ⏳ **Phase 3 Pending**: Add to dashboard (you do this!)

---

## 📚 Files Created

```
app/invoices/
├── _components/
│   ├── preview/
│   │   ├── invoice-components.tsx    ← Sub-components
│   │   └── invoice-template.tsx      ← Main template
│   ├── invoice-preview-sheet.tsx     ← Sheet (slide-over) ✨ NEW
│   └── invoices-dashboard.tsx        ← Update this with integration
└── [invoiceId]/
    └── preview/
        └── page.tsx                   ← Full-page route ✨ NEW
```

---

## 🚨 Troubleshooting

### "Invoice not found"
- Check that the invoiceId exists in your database
- Make sure you have line items for that invoice

### "Customer not loading"
- Verify invoice has a valid customerId
- Check customer hasn't been soft-deleted

### Sheet not opening
- Verify state: `console.log(previewInvoiceId)`
- Check import path for InvoicePreviewSheet

### Styling looks off
- Make sure Tailwind is processing the new files
- Check dark mode classes if using dark theme

---

## 💡 Pro Tips

1. **Keyboard shortcut**: Add Cmd+P listener to dashboard for quick preview
2. **URL deep linking**: Share `/invoices/{id}/preview` URLs directly
3. **Email integration**: Use the preview URL in email notifications
4. **Batch printing**: Select multiple invoices and print all previews
5. **PDF service**: Later, integrate with a PDF generation service for true PDFs

---

Ready to test? Just follow Step 1-4 above and you're done! 🎉
