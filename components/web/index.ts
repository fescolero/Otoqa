/**
 * Otoqa Web — primitive library barrel.
 *
 * Import from `@/components/web` to consume any primitive. Each module is
 * also importable directly for tree-shaking.
 */

export { AttentionBand } from './attention-band';
export type { AttentionItem, AttentionTone } from './attention-band';
export { Avatar } from './avatar';
export { ComplianceMicroBars } from './compliance-micro-bars';
export type { ComplianceItem } from './compliance-micro-bars';
export {
  NowDriverAvailable,
  NowDriverInTransit,
} from './now-card';
export type { DriverActiveLoad, DriverMatchedLoad } from './now-card';
export { QuickStats } from './quick-stats';
export type { QuickStat, DeltaTone } from './quick-stats';
export { CommentsThread } from './comments-thread';
export { BulkAction, BulkBar } from './bulk-bar';
export { WBtn } from './btn';
export type { BtnSize, BtnVariant } from './btn';
export { Checkbox } from './checkbox';
export { Chip, STATUS_PRESETS } from './chip';
export type { ChipStatus } from './chip';
export { ColumnsButton } from './columns-button';
export type { ColumnDef } from './columns-button';
export { CountBadge } from './count-badge';
export type { CountTone } from './count-badge';
export { DetailsFullPage, FPToolbarBtn } from './details-full-page';
export type { FPSection, FPKpi } from './details-full-page';
export { DetailsSlideOver } from './details-slide-over';
export type { DetailsLayout, DetailsSection } from './details-slide-over';
export { DSActivity } from './ds-activity';
export type { DSActivityItem } from './ds-activity';
export { DSCard, DSProps, DSPropsEditable, DSStat, DSSectionBlock } from './ds-card';
export type {
  DSPropItem,
  DSPropsEditableEditor,
  DSPropsEditableItem,
  DSPropsEditableType,
} from './ds-card';
export { DSMiniTable, DSUploadRow } from './ds-mini-table';
export type {
  DSMiniCellEditor,
  DSMiniCellEditorType,
  DSMiniColumn,
  DSRowAction,
} from './ds-mini-table';
export { EditableField } from './editable-field';
export type { EditableSelectOption } from './editable-field';
export { FilterBar } from './filter-bar';
export type {
  FilterChipValue,
  FilterOperator,
  FilterOption,
  FilterProperty,
  FilterPropertyKind,
} from './filter-bar';
export { WIcon } from './icons';
export type { IconName } from './icons';
export { InfiniteFooter } from './infinite-footer';
export { Kbd } from './kbd';
export { PageHeader } from './page-header';
export type { PageHeaderStat } from './page-header';
export { SavedViews, SavedViewsAddButton } from './saved-views';
export type { SavedView } from './saved-views';
export { SavedViewCreatePopover } from './saved-view-create';
export {
  CATEGORY_TONES,
  REASONS_BY_TARGET,
  STATE_MACHINES,
  resolveStatusId,
} from './status-machines';
export type {
  StatusCategory,
  StatusEntity,
  StatusMachine,
  StatusState,
} from './status-machines';
export { StatusHistoryCard } from './status-history-card';
export type { StatusHistoryEntry } from './status-history-card';
export { StatusPicker } from './status-picker';
export type { StatusChangePayload } from './status-picker';
export { Table } from './table';
export type { Density, SortDir, TableColumn } from './table';
export { TableToolbar } from './table-toolbar';
