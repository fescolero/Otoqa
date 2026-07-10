import { VendorDetailContent } from './vendor-detail-content';

export default async function FuelVendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VendorDetailContent vendorId={id} />;
}
