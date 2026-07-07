"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Top-right origin. Sonner picks its slide direction from the
      // position prop — toasts now enter from the right and exit
      // back out the same way (matches where the user's eye is
      // already trained for app-level notifications).
      position="top-right"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // `--bg-surface-elevated` is the "raised surface" tone in
          // the palette — slightly lighter than `--popover` so the
          // toast reads as a floating card rather than a flat slab
          // washed out against the canvas behind it.
          "--normal-bg": "var(--bg-surface-elevated)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border-hairline-strong)",
          "--border-radius": "var(--radius)",
          // Stronger shadow than Sonner's default — gives the toast
          // visible "lift" off the page and keeps it from blending
          // into the underlying content on busy screens.
          boxShadow:
            "0 12px 28px -8px rgba(15, 22, 36, 0.32), 0 4px 8px -2px rgba(15, 22, 36, 0.16)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
