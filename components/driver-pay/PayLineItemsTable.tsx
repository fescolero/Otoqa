'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Lock, Unlock, Trash2, Edit2, Check, X, AlertTriangle } from 'lucide-react';

interface Payable {
  _id: Id<'loadPayables'>;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  sourceType: 'SYSTEM' | 'MANUAL';
  isLocked: boolean;
  warningMessage?: string;
}

interface PayLineItemsTableProps {
  payables: Payable[];
  loadId: Id<'loadInformation'>;
  userId: string;
}

export function PayLineItemsTable({
  payables,
  loadId,
  userId,
}: PayLineItemsTableProps) {
  const [editingId, setEditingId] = useState<Id<'loadPayables'> | null>(null);
  const [editQuantity, setEditQuantity] = useState<string>('');
  const [editRate, setEditRate] = useState<string>('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<Id<'loadPayables'> | null>(null);

  const updatePayable = useMutation(api.loadPayables.update);
  const removePayable = useMutation(api.loadPayables.remove);
  const unlockPayable = useMutation(api.loadPayables.unlock);

  const handleStartEdit = (payable: Payable) => {
    setEditingId(payable._id);
    setEditQuantity(payable.quantity.toString());
    setEditRate(payable.rate.toString());
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditQuantity('');
    setEditRate('');
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;

    const qty = parseFloat(editQuantity);
    const rate = parseFloat(editRate);

    if (isNaN(qty) || isNaN(rate)) {
      alert('Please enter valid numbers');
      return;
    }

    try {
      await updatePayable({
        payableId: editingId,
        quantity: qty,
        rate: rate,
        userId,
      });
      handleCancelEdit();
    } catch (error) {
      console.error('Failed to update payable:', error);
      alert('Failed to update pay item');
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;

    try {
      await removePayable({
        payableId: deletingId,
        userId,
      });
      setDeleteDialogOpen(false);
      setDeletingId(null);
    } catch (error) {
      console.error('Failed to delete payable:', error);
      alert('Failed to delete pay item');
    }
  };

  const handleUnlock = async (payableId: Id<'loadPayables'>) => {
    try {
      await unlockPayable({
        payableId,
        userId,
      });
    } catch (error) {
      console.error('Failed to unlock payable:', error);
      alert('Failed to unlock pay item');
    }
  };

  const confirmDelete = (payableId: Id<'loadPayables'>) => {
    setDeletingId(payableId);
    setDeleteDialogOpen(true);
  };

  // Format currency
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  if (payables.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground border rounded-lg">
        <p>No pay items calculated yet</p>
        <p className="text-sm mt-1">
          Pay items will appear here after calculation
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">Description</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="w-[120px] text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payables.map((payable) => (
              <TableRow key={payable._id}>
                {/* Description */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{payable.description}</span>
                    <Badge
                      variant={payable.sourceType === 'SYSTEM' ? 'secondary' : 'outline'}
                      className="text-xs"
                    >
                      {payable.sourceType}
                    </Badge>
                    {payable.warningMessage && (
                      <Tooltip>
                        <TooltipTrigger>
                          <AlertTriangle className="h-4 w-4 text-yellow-500" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{payable.warningMessage}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </TableCell>

                {/* Quantity */}
                <TableCell className="text-right">
                  {editingId === payable._id ? (
                    <Input
                      type="number"
                      step="0.01"
                      value={editQuantity}
                      onChange={(e) => setEditQuantity(e.target.value)}
                      className="w-20 text-right ml-auto"
                    />
                  ) : (
                    <span>{payable.quantity.toFixed(2)}</span>
                  )}
                </TableCell>

                {/* Rate */}
                <TableCell className="text-right">
                  {editingId === payable._id ? (
                    <Input
                      type="number"
                      step="0.01"
                      value={editRate}
                      onChange={(e) => setEditRate(e.target.value)}
                      className="w-24 text-right ml-auto"
                    />
                  ) : (
                    <span>{formatCurrency(payable.rate)}</span>
                  )}
                </TableCell>

                {/* Total */}
                <TableCell className="text-right font-medium">
                  {editingId === payable._id ? (
                    <span className="text-muted-foreground">
                      {formatCurrency(
                        parseFloat(editQuantity || '0') * parseFloat(editRate || '0')
                      )}
                    </span>
                  ) : (
                    formatCurrency(payable.totalAmount)
                  )}
                </TableCell>

                {/* Actions */}
                <TableCell>
                  <div className="flex items-center justify-center gap-1">
                    {editingId === payable._id ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-green-600"
                          onClick={handleSaveEdit}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600"
                          onClick={handleCancelEdit}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        {/* Lock/Unlock */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() =>
                                payable.isLocked && handleUnlock(payable._id)
                              }
                              disabled={!payable.isLocked}
                            >
                              {payable.isLocked ? (
                                <Lock className="h-4 w-4 text-amber-500" />
                              ) : (
                                <Unlock className="h-4 w-4 text-muted-foreground" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {payable.isLocked
                              ? 'Locked - Click to unlock for recalculation'
                              : 'Unlocked - Will be recalculated'}
                          </TooltipContent>
                        </Tooltip>

                        {/* Edit */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleStartEdit(payable)}
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit amount</TooltipContent>
                        </Tooltip>

                        {/* Delete (manual only) */}
                        {payable.sourceType === 'MANUAL' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-600"
                                onClick={() => confirmDelete(payable._id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete item</TooltipContent>
                          </Tooltip>
                        )}
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Pay Item?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this pay item? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
