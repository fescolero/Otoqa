import { VendorEditContent } from './vendor-edit-content';

export default async function EditFuelVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <VendorEditContent vendorId={resolvedParams.id} />;
}
