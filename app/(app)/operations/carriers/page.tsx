"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Plus, Download, Upload } from "lucide-react";
import { CarrierList } from "@/components/carriers/carrier-list";
import { useRouter } from "next/navigation";
import { useOrganizationId } from "@/contexts/organization-context";

export default function CarriersPage() {
  const router = useRouter();
  const workosOrgId = useOrganizationId();

  const handleCreateCarrier = () => {
    router.push("/operations/carriers/create");
  };

  const handleExportCSV = () => {
    // TODO: Implement CSV export
    console.log("Export CSV clicked");
  };

  const handleImportCSV = () => {
    // TODO: Implement CSV import
    console.log("Import CSV clicked");
  };

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Carriers</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col p-6">
          <div className="flex-shrink-0 flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Carriers</h1>
              <p className="text-muted-foreground">Manage your carrier partners and their information</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCSV}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportCSV}>
                <Upload className="mr-2 h-4 w-4" />
                Import CSV
              </Button>
              <Button size="sm" onClick={handleCreateCarrier}>
                <Plus className="mr-2 h-4 w-4" />
                Create Carrier
              </Button>
            </div>
          </div>
          <CarrierList workosOrgId={workosOrgId} usePartnerships={true} />
        </div>
      </div>
    </>
  );
}
