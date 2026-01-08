# Invoice Preview System - Foundation Setup

## ✅ Completed Steps

### 1. Utility Functions (`lib/utils/invoice.ts`)
Created formatting helpers for invoice display:
- `formatCurrency(amount, currency)` - Formats numbers as currency (USD, CAD, MXN)
- `formatDate(dateString)` - Formats ISO date strings to readable format
- `formatTimestamp(timestamp)` - Formats Unix timestamps to readable format

**Usage:**
```typescript
import { formatCurrency, formatDate } from '@/lib/utils/invoice';

formatCurrency(1234.56, 'USD'); // "$1,234.56"
formatDate('2024-01-15'); // "Jan 15, 2024"
```

### 2. Convex Backend Queries

#### Added to `convex/invoices.ts`:
- `getById(invoiceId)` - Get a single invoice by ID
- `getLineItems(invoiceId)` - Get all line items for an invoice

#### Added to `convex/customers.ts`:
- `getById(customerId)` - Get a single customer by ID

**Usage:**
```typescript
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';

const invoice = useQuery(api.invoices.getById, { invoiceId });
const lineItems = useQuery(api.invoices.getLineItems, { invoiceId });
const customer = useQuery(api.customers.getById, { customerId: invoice?.customerId });
```

### 3. Existing Infrastructure
- ✅ `cn()` utility already exists in `lib/utils.ts`
- ✅ Radix UI components (Sheet, ScrollArea, etc.) already installed
- ✅ Tailwind CSS configured
- ✅ Sonner for toast notifications

## 📋 Next Steps

### Phase 1: UI Components (Ready to implement)
1. Create `app/invoices/_components/preview/invoice-components.tsx`
   - InvoiceMeta
   - BillTo
   - LineItemsTable
   - InvoiceSummary

2. Create `app/invoices/_components/preview/invoice-template.tsx`
   - Main presentation component
   - Uses all sub-components

### Phase 2: Integration
3. Create `app/invoices/_components/invoice-preview-sheet.tsx`
   - Slide-over preview using Sheet component
   - Connects to Convex queries
   - Toolbar with Print/Download/Full Page buttons

4. Create `app/invoices/[invoiceId]/preview/page.tsx`
   - Full-page preview route
   - Print/PDF friendly
   - Uses same InvoiceTemplate component

### Phase 3: Dashboard Integration
5. Update `app/invoices/_components/invoices-dashboard.tsx`
   - Add "Preview" button to invoice list
   - State management for selected invoice
   - Render InvoicePreviewSheet

## 🔧 Configuration Needed

### Organization Details
The preview will need your company information:

```typescript
const companyDetails = {
  name: "Otoqa Logistics Inc.",
  email: "billing@otoqa.com",
  address: "123 Logistics Way\nLos Angeles, CA 90001",
  logoUrl: "/logo.png" // Optional
};
```

**Options:**
1. Hardcode in template (quick start)
2. Store in Convex `organizations` table
3. Environment variables
4. User settings page

## 📊 Data Flow

```
Invoice Dashboard
    ↓
[Preview Button Click]
    ↓
InvoicePreviewSheet (Sheet opens)
    ↓
Fetches: invoice + lineItems + customer (Convex)
    ↓
InvoiceTemplate (Presentation)
    ↓
Renders: Header, Meta, BillTo, LineItems, Summary
```

## 🎨 Design Features

From the Midday.ai template:
- Professional invoice layout
- Responsive (mobile-friendly)
- Print-optimized
- Dark mode support
- Monospace fonts for numbers
- Status badges
- Line item categorization (FREIGHT, FUEL, ACCESSORIAL, TAX)

## 🧪 Testing

Basic tests created in `lib/utils/__tests__/invoice.test.ts`

To add more tests:
```bash
npm test -- invoice
```

## 🚀 Deployment Status

✅ **Backend**: Convex queries deployed and ready
✅ **Utilities**: Invoice formatting functions ready
⏳ **UI Components**: Ready to create
⏳ **Integration**: Ready to wire up

## 📚 Resources

- Original template: Midday.ai invoice preview
- Convex schema: `convex/schema.ts` (lines 694-760)
- Component library: `components/ui/`
