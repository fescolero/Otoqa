# Persistent Layout Migration Plan

## Problem
The AppSidebar component is being remounted on every page navigation, causing:
- Flashing/flickering of the sidebar
- Re-fetching of organization data (even with caching, shows skeleton)
- Poor user experience during navigation

## Root Cause
Each page (dashboard, invoices, fleet, etc.) creates its own instance of:
- `<SidebarProvider>`
- `<AppSidebar>`
- `<SidebarInset>`

When navigating between pages, React unmounts the old page's components and mounts the new page's components, causing the sidebar to remount.

## Solution
Create a Next.js Route Group with a persistent layout that wraps all authenticated pages.

### What is a Route Group?
- Folder name: `(app)` - parentheses mean it's a route group
- Route groups don't affect the URL structure
- They allow you to organize routes and apply layouts without changing URLs
- Example: `/app/(app)/dashboard/page.tsx` → URL is still `/dashboard`

### Changes Required

#### 1. Create Route Group Structure
```
app/
  ├── (app)/                    # NEW: Route group for authenticated pages
  │   ├── layout.tsx            # NEW: Persistent layout with sidebar
  │   ├── dashboard/
  │   │   └── page.tsx          # MOVED from app/dashboard/page.tsx
  │   ├── invoices/
  │   │   └── ...               # MOVED from app/invoices/
  │   ├── fleet/
  │   │   └── ...               # MOVED from app/fleet/
  │   ├── loads/
  │   │   └── ...               # MOVED from app/loads/
  │   ├── operations/
  │   │   └── ...               # MOVED from app/operations/
  │   ├── account/
  │   │   └── ...               # MOVED from app/account/
  │   └── org-settings/
  │       └── ...               # MOVED from app/org-settings/
  ├── layout.tsx                # Root layout (stays)
  ├── page.tsx                  # Root page (stays)
  ├── sign-in/                  # NOT MOVED (auth pages)
  ├── sign-up/                  # NOT MOVED (auth pages)
  ├── callback/                 # NOT MOVED (auth pages)
  └── api/                      # NOT MOVED (API routes)
```

#### 2. Create Persistent Layout (`app/(app)/layout.tsx`)
This will contain the `SidebarProvider`, `AppSidebar`, and `SidebarInset` wrapper.

#### 3. Update All Page Files
Remove the layout components from each page:
- Remove: `<SidebarProvider>`, `<AppSidebar>`, `<SidebarInset>`
- Remove: User data fetching (will be in layout)
- Keep: Page-specific content, headers, breadcrumbs

### What Won't Break

#### URLs - All URLs remain the same:
- ✅ `/dashboard` → works
- ✅ `/invoices` → works
- ✅ `/fleet/drivers` → works
- ✅ `/operations/customers` → works
- All existing routes maintain their exact same URLs

#### Functionality:
- ✅ Middleware still works (protects all routes under `/`)
- ✅ API routes unaffected (in `/api`)
- ✅ Auth flows unaffected (sign-in, sign-up, callback)
- ✅ All page content renders the same
- ✅ Breadcrumbs, headers, and page-specific UI unchanged

#### Benefits:
- ✅ Sidebar persists across navigation (no remounting)
- ✅ No flashing during page changes
- ✅ Organization data fetched once and cached
- ✅ Faster page transitions
- ✅ Better user experience

### Pages to Update (Count: ~50+ files)
All files currently using the sidebar pattern need updating:

**Main sections:**
- `dashboard/page.tsx`
- `invoices/page.tsx` + all invoice detail pages
- `fleet/drivers/**/*.tsx` (list, create, detail, edit)
- `fleet/trucks/**/*.tsx` (list, create, detail, edit)
- `fleet/trailers/**/*.tsx` (list, create, detail, edit)
- `operations/customers/**/*.tsx` (list, create, detail, edit, contract lanes)
- `operations/carriers/**/*.tsx` (list, create, detail, edit)
- `loads/**/*.tsx` (list, detail, create)
- `account/page.tsx`
- `org-settings/page.tsx`

### Migration Steps
1. Create `app/(app)` directory
2. Create `app/(app)/layout.tsx` with persistent sidebar
3. Move each directory one at a time (test after each move):
   - Move `dashboard/` → test
   - Move `account/` → test
   - Move `org-settings/` → test
   - Move `invoices/` → test
   - Move `fleet/` → test
   - Move `loads/` → test
   - Move `operations/` → test
4. Update each page file to remove sidebar components
5. Test all routes and functionality

### Rollback Plan
If anything breaks:
1. Keep the `(app)` folder
2. Move directories back to `app/` root
3. Restore sidebar components in page files
4. Git can easily revert these changes (file moves)

### Testing Checklist
- [ ] All URLs still work
- [ ] Navigation between pages (no flashing)
- [ ] Sidebar state persists (collapsed/expanded)
- [ ] User data displays correctly
- [ ] Organization logo shows
- [ ] Breadcrumbs work
- [ ] Auth still protects routes
- [ ] API routes work
- [ ] Can create/edit/delete in all sections
- [ ] Mobile sidebar works

## Estimated Time
- Setup: 10 minutes
- Migration: 30-45 minutes (moving files + updating pages)
- Testing: 15-20 minutes

## Risk Assessment
**Low Risk** - This is a structural change, not a functional change. URLs don't change, only internal organization.
