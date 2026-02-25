'use client';

import { useState, useRef, useEffect } from 'react';
import { useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Bot, User } from 'lucide-react';
import { toast } from 'sonner';
import type { ExtractionConfig, ExtractedLane, ChatMessage } from './schedule-import-types';

interface ScheduleChatPanelProps {
  lanes: ExtractedLane[];
  config: ExtractionConfig;
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[]) => void;
  onLanesChange: (lanes: ExtractedLane[]) => void;
}

function getActiveColumns(config: ExtractionConfig): string[] {
  const cols = ['hcr', 'tripNumber', 'contractName'];
  if (config.extractDates) cols.push('contractPeriodStart', 'contractPeriodEnd');
  if (config.includeFinancial) cols.push('rate', 'rateType', 'currency', 'minimumRate');
  if (config.includeFuelSurcharge) cols.push('fuelSurchargeType', 'fuelSurchargeValue');
  if (config.includeLogistics && config.stopDetailLevel !== 'none') cols.push('stops', 'miles');
  if (config.includeEquipment) cols.push('equipmentClass', 'equipmentSize');
  return cols;
}

function compactLanesForChat(lanes: ExtractedLane[], activeColumns: string[]): Record<string, unknown>[] {
  return lanes.map((lane) => {
    const compact: Record<string, unknown> = {};
    for (const col of activeColumns) {
      if (col === 'stops' && lane.stops) {
        compact.stops = lane.stops.map((s) => ({
          city: s.city?.value,
          state: s.state?.value,
          stopType: s.stopType?.value,
        }));
        continue;
      }
      const field = lane[col as keyof ExtractedLane];
      if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
        compact[col] = (field as { value: unknown }).value;
      }
    }
    return compact;
  });
}

function applyChangesToLanes(
  originalLanes: ExtractedLane[],
  updatedCompact: Record<string, unknown>[],
): ExtractedLane[] {
  return originalLanes.map((lane, i) => {
    const updates = updatedCompact[i];
    if (!updates) return lane;

    const updated = { ...lane };
    for (const [key, newVal] of Object.entries(updates)) {
      if (key === 'stops' || key.startsWith('_')) continue;
      const existing = updated[key as keyof ExtractedLane];
      if (existing && typeof existing === 'object' && 'value' in (existing as Record<string, unknown>)) {
        (updated as Record<string, unknown>)[key] = {
          ...(existing as Record<string, unknown>),
          value: newVal,
          confidence: 'high',
        };
      }
    }
    return updated;
  });
}

export function ScheduleChatPanel({
  lanes,
  config,
  messages,
  onMessagesChange,
  onLanesChange,
}: ScheduleChatPanelProps) {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const applyCorrection = useAction(api.scheduleImport.applyChatCorrection);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    onMessagesChange(updatedMessages);
    setInput('');
    setIsLoading(true);

    try {
      const activeColumns = getActiveColumns(config);
      const compactLanes = compactLanesForChat(lanes, activeColumns);

      const result = await applyCorrection({
        lanes: compactLanes,
        userMessage: trimmed,
        conversationHistory: updatedMessages.slice(-10),
        activeColumns,
      });

      if (result.error) {
        toast.error(result.error);
        onMessagesChange([
          ...updatedMessages,
          { role: 'assistant', content: `Error: ${result.error}` },
        ]);
      } else {
        const mergedLanes = applyChangesToLanes(
          lanes,
          result.lanes as Record<string, unknown>[],
        );
        onLanesChange(mergedLanes);
        const changeCount = result.changedCells?.length || 0;
        const response =
          result.explanation +
          (changeCount > 0 ? ` (${changeCount} cell${changeCount !== 1 ? 's' : ''} changed)` : '');
        onMessagesChange([
          ...updatedMessages,
          { role: 'assistant', content: response },
        ]);
      }
    } catch (err) {
      console.error('Chat correction failed:', err);
      onMessagesChange([
        ...updatedMessages,
        {
          role: 'assistant',
          content: 'Something went wrong. Please try again.',
        },
      ]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-full bg-muted/20">
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-8 space-y-2">
              <Bot className="h-8 w-8 mx-auto opacity-40" />
              <p>Describe corrections in natural language.</p>
              <div className="text-xs space-y-1 text-left max-w-[260px] mx-auto">
                <p className="font-medium text-muted-foreground/80">Examples:</p>
                <p>&ldquo;Change the rate for trip 210 to $2.50&rdquo;</p>
                <p>&ldquo;All rates should be Flat Rate&rdquo;</p>
                <p>&ldquo;Remove rows 5 through 8&rdquo;</p>
                <p>&ldquo;The HCR for all rows is 925L0&rdquo;</p>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <Bot className="h-5 w-5 text-primary shrink-0 mt-1" />
              )}
              <div
                className={`rounded-lg px-3 py-2 text-sm max-w-[280px] ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background border'
                }`}
              >
                {msg.content}
              </div>
              {msg.role === 'user' && (
                <User className="h-5 w-5 text-muted-foreground shrink-0 mt-1" />
              )}
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-2 items-center">
              <Bot className="h-5 w-5 text-primary shrink-0" />
              <div className="bg-background border rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-3 border-t shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2"
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe a correction..."
            disabled={isLoading}
            className="text-sm"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || isLoading}
            className="shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
