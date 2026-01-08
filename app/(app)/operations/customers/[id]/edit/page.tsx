import { CustomerEditContent } from './customer-edit-content';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  return <CustomerEditContent customerId={resolvedParams.id} />;
}
