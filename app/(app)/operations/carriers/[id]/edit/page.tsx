import { CarrierEditContent } from './carrier-edit-content';

export default async function EditCarrierPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <CarrierEditContent carrierId={resolvedParams.id} />;
}
