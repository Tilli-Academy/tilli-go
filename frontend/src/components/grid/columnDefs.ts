import type {
  ColDef,
  ValueFormatterParams,
  ValueGetterParams,
  EditableCallbackParams,
} from 'ag-grid-community';
import StatusRenderer from './cellRenderers/StatusDropdown';
import DateTimeEditor, { DateTimeRenderer } from './cellRenderers/DateTimePicker';
import DependencyEditor, {
  DependencyRenderer,
} from './cellRenderers/DependencyDropdown';
import { TASK_STATUSES, SYSTEMS, isLockedStatus } from '../../utils/constants';
import { dateTimeIn, zoneName } from '../../utils/zoneTime';
import type { Task } from '../../types';
import { formatDuration } from '../../modules/cutover/duration';
import { alertLabel, hhmm } from '../../modules/alerts/alertMeta';

function isEditable(params: EditableCallbackParams<Task>): boolean {
  return !isLockedStatus(params.data?.status); // Completed and N/A are locked
}

function displayIdGetter(params: ValueGetterParams<Task>): string {
  const code = params.data?.project?.code || '???';
  const seq = params.data?.sequenceNumber;
  return `${code}-${seq}`;
}

export interface GridOptions {
  /** The project's zone: times are shown and typed in it, and the headers name it. */
  timeZone: string;
  /** Change requests of the project, for the optional task → CR tag. */
  changeRequests: { id: string; number: number; title: string }[];
}

export function buildColumnDefs({ timeZone, changeRequests }: GridOptions): ColDef<Task>[] {
  const zone = zoneName(timeZone);
  const inZone = (params: ValueFormatterParams<Task, string | null>) => (params.value ? dateTimeIn(params.value, timeZone) : '');
  const crLabel = (id: string | null | undefined) => {
    if (!id) return '—';
    const cr = changeRequests.find((c) => c.id === id);
    return cr ? `CR-${cr.number}` : '—';
  };
  return [
    {
      headerName: 'ID',
      valueGetter: displayIdGetter,
      width: 120,
      editable: false,
      pinned: 'left',
    },
    {
      field: 'system',
      headerName: 'System',
      width: 130,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: SYSTEMS },
      editable: isEditable,
    },
    {
      field: 'taskName',
      headerName: 'Task Name',
      flex: 1,
      minWidth: 180,
      editable: isEditable,
    },
    {
      // Optional tag: which change request (in this project) the task is for. A CR with
      // tagged tasks only waits for those at Review, not for the whole release.
      field: 'changeRequestId',
      headerName: 'Change request',
      headerTooltip: 'Optional. A change request with tagged tasks only waits for those at Review.',
      width: 150,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['', ...changeRequests.map((c) => c.id)] },
      valueFormatter: (p: ValueFormatterParams<Task, string | null>) => crLabel(p.value),
      tooltipValueGetter: (p) => changeRequests.find((c) => c.id === p.value)?.title ?? '',
      valueParser: (p) => (p.newValue ? p.newValue : null),
      editable: (p) => isEditable(p) && changeRequests.length > 0,
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 1,
      minWidth: 150,
      editable: isEditable,
    },
    {
      field: 'assignedTeam',
      headerName: 'Team',
      width: 130,
      editable: isEditable,
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 150,
      cellRenderer: StatusRenderer,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: TASK_STATUSES },
      editable: isEditable,
    },
    {
      field: 'dependencies',
      headerName: 'Dependencies',
      width: 200,
      cellRenderer: DependencyRenderer,
      cellEditor: DependencyEditor,
      cellEditorPopup: true,
      editable: isEditable,
    },
    {
      field: 'plannedStartTime',
      headerName: `Planned Start (${zone})`,
      width: 190,
      cellRenderer: DateTimeRenderer,
      cellEditor: DateTimeEditor,
      cellEditorPopup: true,
      editable: isEditable,
    },
    {
      field: 'plannedEndTime',
      headerName: `Planned End (${zone})`,
      width: 190,
      cellRenderer: DateTimeRenderer,
      cellEditor: DateTimeEditor,
      cellEditorPopup: true,
      editable: isEditable,
    },
    {
      // Read-only: 0:00 checkpoints, multi-day tasks and N/A (no end) are all valid.
      headerName: 'Duration',
      width: 140,
      editable: false,
      valueGetter: (p: ValueGetterParams<Task>) => formatDuration(p.data?.plannedStartTime ?? null, p.data?.plannedEndTime ?? null),
    },
    {
      // Read-only: set by the worker when the start-time alert goes out / is acknowledged.
      headerName: 'Start-time alert',
      width: 230,
      editable: false,
      valueGetter: (p: ValueGetterParams<Task>) => {
        const a = p.data?.alert;
        const l = alertLabel(a, p.data?.status);
        const when = a?.acknowledgedAt ? ` · started ${hhmm(a.acknowledgedAt, timeZone)}` : a?.sentAt ? ` · ${hhmm(a.sentAt, timeZone)}` : '';
        return `${l.icon ? `${l.icon} ` : ''}${l.label}${when}`;
      },
    },
    {
      field: 'actualStartTime',
      headerName: `Actual Start (${zone})`,
      width: 190,
      editable: false,
      valueFormatter: inZone,
    },
    {
      field: 'actualEndTime',
      headerName: `Actual End (${zone})`,
      width: 190,
      editable: false,
      valueFormatter: inZone,
    },
    {
      field: 'notes',
      headerName: 'Notes',
      flex: 1,
      minWidth: 120,
      editable: isEditable,
    },
  ];
}
