"use client"

import * as React from "react"
import { ChevronsUpDown, Plus } from "lucide-react"
import { Building2 } from "lucide-react"
import Image from "next/image"

const { memo } = React

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

interface Organization {
  id: string
  name: string
  logoUrl: string | null
  plan: string
}

const TeamSwitcherComponent = ({
  organizations,
}: {
  organizations: Organization[]
}) => {
  const { isMobile } = useSidebar()
  const [activeOrg, setActiveOrg] = React.useState(organizations[0])

  // Update activeOrg when organizations change (e.g., when logo loads)
  React.useEffect(() => {
    if (organizations.length > 0) {
      // Update activeOrg with the latest data from the organizations array
      setActiveOrg(prev => {
        const updated = organizations.find(org => org.id === prev?.id)
        return updated || organizations[0]
      })
    }
  }, [organizations])

  if (!activeOrg) {
    return null
  }

  // Single organization - show without dropdown
  if (organizations.length === 1) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg overflow-hidden">
              {activeOrg.logoUrl ? (
                <Image 
                  src={activeOrg.logoUrl} 
                  alt={activeOrg.name}
                  width={32}
                  height={32}
                  className="object-cover"
                />
              ) : (
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center size-full">
                  <span className="text-sm font-semibold">
                    {activeOrg.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeOrg.name}</span>
              <span className="truncate text-xs">{activeOrg.plan}</span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  // Multiple organizations - show with dropdown
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg overflow-hidden">
                {activeOrg.logoUrl ? (
                  <Image 
                    src={activeOrg.logoUrl} 
                    alt={activeOrg.name}
                    width={32}
                    height={32}
                    className="object-cover"
                  />
                ) : (
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center size-full">
                    <span className="text-sm font-semibold">
                      {activeOrg.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{activeOrg.name}</span>
                <span className="truncate text-xs">{activeOrg.plan}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Organizations
            </DropdownMenuLabel>
            {organizations.map((org, index) => (
              <DropdownMenuItem
                key={org.id}
                onClick={() => setActiveOrg(org)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-md border overflow-hidden">
                  {org.logoUrl ? (
                    <Image 
                      src={org.logoUrl} 
                      alt={org.name}
                      width={24}
                      height={24}
                      className="object-cover"
                    />
                  ) : (
                    <div className="bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center size-full">
                      <span className="text-xs">
                        {org.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                {org.name}
                <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

// Memoize to prevent unnecessary re-renders
export const TeamSwitcher = memo(TeamSwitcherComponent, (prev, next) => {
  // Only re-render if organizations actually changed
  if (prev.organizations.length !== next.organizations.length) return false
  
  // Check if any organization data changed
  return prev.organizations.every((org, index) => {
    const nextOrg = next.organizations[index]
    return (
      org.id === nextOrg.id &&
      org.name === nextOrg.name &&
      org.logoUrl === nextOrg.logoUrl &&
      org.plan === nextOrg.plan
    )
  })
})
