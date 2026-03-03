import { FuelEntryEditContent } from './fuel-entry-edit-content';

export default async function EditFuelEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <FuelEntryEditContent id={resolvedParams.id} />;
}
