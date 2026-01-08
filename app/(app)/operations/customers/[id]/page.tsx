import { CustomerDetailContent } from './customer-detail-content';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <CustomerDetailContent customerId={resolvedParams.id} />;
}
