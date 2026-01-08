import { CarrierDetailContent } from './carrier-detail-content';

export default async function CarrierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <CarrierDetailContent carrierId={resolvedParams.id} />;
}
