import { FuelEntryDetailContent } from './fuel-entry-detail-content';

export default async function FuelEntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <FuelEntryDetailContent id={resolvedParams.id} />;
}
