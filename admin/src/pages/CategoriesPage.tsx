// EthioLink admin — Categories CRUD.
//
// Single-page interface — categories are a small fixed set (four
// MVP rows: Salon, Barber, Spa, Beauty Professional) so a separate
// detail page would be overkill. Three sections stacked top-to-
// bottom:
//
//   1. **Filter selector** — All / Active / Inactive.
//   2. **Create form** — slug + name.en + name.am? + sortOrder?.
//      Always visible.
//   3. **Table** — every row that matches the filter. Each row has
//      its own Edit / Deactivate actions. When `editingId` matches
//      the row id, the row renders as a `EditCategoryRow` form
//      with Save / Cancel; otherwise as a `DisplayCategoryRow`.
//
// Reactivation isn't in MVP scope — the backend service doesn't
// expose a `setIsActive(true)` path, and the dashboard mirrors
// that. If a category is deactivated by mistake the admin can
// create a new row with the same intent under a new slug.
//
// Error handling: every mutation surfaces `ApiError.code`,
// `ApiError.message`, and (when present) `ApiError.details.field`
// so the admin can see which input was rejected — slug uniqueness
// vs invalid name.en vs out-of-range sortOrder.

import { useState } from 'react';
import {
    type UseMutationResult,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';

import {
    type AdminCategoryView,
    ApiError,
    createCategory,
    deactivateCategory,
    listAdminCategories,
    patchCategory,
} from '../lib/api';

type Filter = 'ALL' | 'ACTIVE' | 'INACTIVE';

const FILTER_OPTIONS: ReadonlyArray<{ label: string; value: Filter }> = [
    { label: 'All', value: 'ALL' },
    { label: 'Active only', value: 'ACTIVE' },
    { label: 'Inactive only', value: 'INACTIVE' },
];

const QUERY_KEY = ['adminCategories'] as const;

export function CategoriesPage() {
    const queryClient = useQueryClient();
    const [filter, setFilter] = useState<Filter>('ALL');
    const [editingId, setEditingId] = useState<string | null>(null);

    const { data, isLoading, error, isFetching } = useQuery({
        queryKey: [...QUERY_KEY, filter],
        queryFn: () =>
            listAdminCategories({
                isActive:
                    filter === 'ACTIVE'
                        ? true
                        : filter === 'INACTIVE'
                          ? false
                          : undefined,
                limit: 100,
            }),
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Categories</h1>

            <label style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                <span>Show</span>
                <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as Filter)}
                    style={{ padding: '0.25rem 0.5rem' }}
                >
                    {FILTER_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
                {isFetching && !isLoading && (
                    <span style={{ marginLeft: '0.5rem', color: '#666', fontSize: '0.875rem' }}>
                        Refreshing…
                    </span>
                )}
            </label>

            <CreateCategoryCard onSaved={invalidate} />

            {isLoading && <p>Loading…</p>}
            {error && <ErrorLine error={error} />}
            {data && data.items.length === 0 && (
                <p style={{ marginTop: '1.5rem', color: '#666' }}>
                    No categories match this filter.
                </p>
            )}
            {data && data.items.length > 0 && (
                <CategoriesTable
                    rows={data.items}
                    editingId={editingId}
                    onEdit={setEditingId}
                    onCancelEdit={() => setEditingId(null)}
                    onSaved={() => {
                        setEditingId(null);
                        invalidate();
                    }}
                    onDeactivated={invalidate}
                />
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function CreateCategoryCard({ onSaved }: { onSaved: () => void }) {
    const [slug, setSlug] = useState('');
    const [nameEn, setNameEn] = useState('');
    const [nameAm, setNameAm] = useState('');
    const [sortOrder, setSortOrder] = useState('');

    const mutation = useMutation({
        mutationFn: () =>
            createCategory({
                slug: slug.trim(),
                name: {
                    en: nameEn.trim(),
                    ...(nameAm.trim() !== '' ? { am: nameAm.trim() } : {}),
                },
                sortOrder:
                    sortOrder.trim() === '' ? undefined : Number(sortOrder),
            }),
        onSuccess: () => {
            setSlug('');
            setNameEn('');
            setNameAm('');
            setSortOrder('');
            onSaved();
        },
    });

    return (
        <article
            style={{
                marginTop: '1.5rem',
                border: '1px solid #ddd',
                borderRadius: 6,
                padding: '1rem 1.25rem',
            }}
        >
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>New category</h2>
            <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: '1fr 1fr', maxWidth: 720 }}>
                <Field
                    label="Slug"
                    hint="Machine key, e.g. salon"
                    error={fieldErrorOf(mutation, 'slug')}
                >
                    <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        maxLength={64}
                        style={inputStyle}
                    />
                </Field>
                <Field
                    label="Sort order"
                    hint="Optional integer, defaults to 0"
                    error={fieldErrorOf(mutation, 'sortOrder')}
                >
                    <input
                        type="number"
                        min={0}
                        step={1}
                        value={sortOrder}
                        onChange={(e) => setSortOrder(e.target.value)}
                        style={inputStyle}
                    />
                </Field>
                <Field
                    label="Name (English)"
                    error={fieldErrorOf(mutation, 'name.en') ?? fieldErrorOf(mutation, 'name')}
                >
                    <input
                        value={nameEn}
                        onChange={(e) => setNameEn(e.target.value)}
                        maxLength={200}
                        style={inputStyle}
                    />
                </Field>
                <Field label="Name (Amharic)" hint="Optional" error={fieldErrorOf(mutation, 'name.am')}>
                    <input
                        value={nameAm}
                        onChange={(e) => setNameAm(e.target.value)}
                        maxLength={200}
                        style={inputStyle}
                    />
                </Field>
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate()}
                    style={buttonStyle(mutation.isPending)}
                >
                    {mutation.isPending ? 'Creating…' : 'Create category'}
                </button>
                {mutation.isSuccess && (
                    <span style={{ color: '#15803d' }}>✓ Created.</span>
                )}
            </div>
            <NonFieldError mutation={mutation} />
        </article>
    );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function CategoriesTable({
    rows,
    editingId,
    onEdit,
    onCancelEdit,
    onSaved,
    onDeactivated,
}: {
    rows: readonly AdminCategoryView[];
    editingId: string | null;
    onEdit: (id: string) => void;
    onCancelEdit: () => void;
    onSaved: () => void;
    onDeactivated: () => void;
}) {
    return (
        <table
            style={{
                marginTop: '1rem',
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.95rem',
            }}
        >
            <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                    <th style={th}>Slug</th>
                    <th style={th}>Name (en / am)</th>
                    <th style={th}>Sort</th>
                    <th style={th}>Active</th>
                    <th style={th}>Updated</th>
                    <th style={th}>Actions</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) =>
                    row.id === editingId ? (
                        <EditCategoryRow
                            key={row.id}
                            row={row}
                            onCancel={onCancelEdit}
                            onSaved={onSaved}
                        />
                    ) : (
                        <DisplayCategoryRow
                            key={row.id}
                            row={row}
                            onEdit={() => onEdit(row.id)}
                            onDeactivated={onDeactivated}
                        />
                    ),
                )}
            </tbody>
        </table>
    );
}

function DisplayCategoryRow({
    row,
    onEdit,
    onDeactivated,
}: {
    row: AdminCategoryView;
    onEdit: () => void;
    onDeactivated: () => void;
}) {
    const mutation = useMutation({
        mutationFn: () => deactivateCategory(row.id),
        onSuccess: onDeactivated,
    });

    const handleDeactivate = () => {
        if (!window.confirm(`Deactivate "${row.slug}"? Existing businesses keep their category reference; the row stays in the database but is hidden from public listings.`)) {
            return;
        }
        mutation.mutate();
    };

    return (
        <tr style={{ borderBottom: '1px solid #eee' }}>
            <td style={td}><code>{row.slug}</code></td>
            <td style={td}>
                <span>{row.name.en}</span>
                {row.name.am !== undefined && (
                    <span style={{ color: '#666', marginLeft: '0.5rem' }}>
                        / {row.name.am}
                    </span>
                )}
            </td>
            <td style={td}>{row.sortOrder}</td>
            <td style={td}>
                {row.isActive ? (
                    <span style={{ color: '#15803d', fontWeight: 600 }}>Yes</span>
                ) : (
                    <span style={{ color: '#999' }}>No</span>
                )}
            </td>
            <td style={td}>{new Date(row.updatedAt).toLocaleDateString()}</td>
            <td style={td}>
                <button type="button" onClick={onEdit} style={smallButton}>
                    Edit
                </button>
                {row.isActive && (
                    <>
                        {' '}
                        <button
                            type="button"
                            disabled={mutation.isPending}
                            onClick={handleDeactivate}
                            style={smallButton}
                        >
                            {mutation.isPending ? 'Deactivating…' : 'Deactivate'}
                        </button>
                    </>
                )}
                {mutation.error && (
                    <div style={{ color: 'crimson', marginTop: '0.25rem' }}>
                        {formatError(mutation.error)}
                    </div>
                )}
            </td>
        </tr>
    );
}

function EditCategoryRow({
    row,
    onCancel,
    onSaved,
}: {
    row: AdminCategoryView;
    onCancel: () => void;
    onSaved: () => void;
}) {
    const [slug, setSlug] = useState(row.slug);
    const [nameEn, setNameEn] = useState(row.name.en);
    const [nameAm, setNameAm] = useState(row.name.am ?? '');
    const [sortOrder, setSortOrder] = useState(String(row.sortOrder));

    const mutation = useMutation({
        mutationFn: () =>
            patchCategory(row.id, {
                slug: slug.trim() !== row.slug ? slug.trim() : undefined,
                name:
                    nameEn.trim() !== row.name.en ||
                    (nameAm.trim() || undefined) !== row.name.am
                        ? {
                              en: nameEn.trim(),
                              ...(nameAm.trim() !== ''
                                  ? { am: nameAm.trim() }
                                  : {}),
                          }
                        : undefined,
                sortOrder:
                    Number(sortOrder) !== row.sortOrder
                        ? Number(sortOrder)
                        : undefined,
            }),
        onSuccess: onSaved,
    });

    return (
        <tr style={{ borderBottom: '1px solid #eee', background: '#fafafa' }}>
            <td style={td}>
                <input
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    maxLength={64}
                    style={inputStyle}
                />
                {fieldErrorOf(mutation, 'slug') && (
                    <div style={fieldErrorStyle}>{fieldErrorOf(mutation, 'slug')}</div>
                )}
            </td>
            <td style={td}>
                <input
                    value={nameEn}
                    onChange={(e) => setNameEn(e.target.value)}
                    maxLength={200}
                    placeholder="English"
                    style={{ ...inputStyle, marginBottom: '0.25rem' }}
                />
                <input
                    value={nameAm}
                    onChange={(e) => setNameAm(e.target.value)}
                    maxLength={200}
                    placeholder="Amharic (optional)"
                    style={inputStyle}
                />
                {(fieldErrorOf(mutation, 'name.en') ||
                    fieldErrorOf(mutation, 'name.am') ||
                    fieldErrorOf(mutation, 'name')) && (
                    <div style={fieldErrorStyle}>
                        {fieldErrorOf(mutation, 'name.en') ??
                            fieldErrorOf(mutation, 'name.am') ??
                            fieldErrorOf(mutation, 'name')}
                    </div>
                )}
            </td>
            <td style={td}>
                <input
                    type="number"
                    min={0}
                    step={1}
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    style={{ ...inputStyle, width: 80 }}
                />
                {fieldErrorOf(mutation, 'sortOrder') && (
                    <div style={fieldErrorStyle}>{fieldErrorOf(mutation, 'sortOrder')}</div>
                )}
            </td>
            <td style={td}>
                {row.isActive ? (
                    <span style={{ color: '#15803d', fontWeight: 600 }}>Yes</span>
                ) : (
                    <span style={{ color: '#999' }}>No</span>
                )}
            </td>
            <td style={td}>—</td>
            <td style={td}>
                <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate()}
                    style={smallButton}
                >
                    {mutation.isPending ? 'Saving…' : 'Save'}
                </button>{' '}
                <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={onCancel}
                    style={smallButton}
                >
                    Cancel
                </button>
                <NonFieldError mutation={mutation} />
            </td>
        </tr>
    );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Field({
    label,
    hint,
    error,
    children,
}: {
    label: string;
    hint?: string;
    error?: string | undefined;
    children: React.ReactNode;
}) {
    return (
        <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: '0.875rem', color: '#555' }}>
                {label}
            </span>
            {children}
            {hint && !error && (
                <span style={{ display: 'block', fontSize: '0.8rem', color: '#888', marginTop: '0.125rem' }}>
                    {hint}
                </span>
            )}
            {error && <div style={fieldErrorStyle}>{error}</div>}
        </label>
    );
}

/**
 * Pull a field-specific message out of an `AdminCategoryInvalidInputError`
 * shaped response (`details.field === '<name>'`). Returns `undefined` if
 * the mutation hasn't errored or the error doesn't carry a matching
 * `details.field`. The non-field-specific message renders separately via
 * `NonFieldError`.
 */
function fieldErrorOf(
    mutation: UseMutationResult<unknown, unknown, void>,
    field: string,
): string | undefined {
    const err = mutation.error;
    if (!(err instanceof ApiError)) return undefined;
    if (err.details?.field !== field) return undefined;
    return err.message;
}

function NonFieldError({ mutation }: { mutation: UseMutationResult<unknown, unknown, void> }) {
    const err = mutation.error;
    if (!err) return null;
    if (err instanceof ApiError && typeof err.details?.field === 'string') {
        // The field-level message already renders next to the input;
        // suppress the duplicate here.
        return null;
    }
    return (
        <p style={{ color: 'crimson', marginTop: '0.5rem' }}>{formatError(err)}</p>
    );
}

function ErrorLine({ error }: { error: unknown }) {
    return (
        <p style={{ color: 'crimson' }}>
            Failed to load: {formatError(error)}
        </p>
    );
}

function formatError(err: unknown): string {
    if (err instanceof ApiError) {
        return `${err.code ?? 'ERROR'} — ${err.message}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
}

// ---------------------------------------------------------------------------
// Inline styles — kept minimal per the Phase 5 scaffold convention
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.375rem 0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    boxSizing: 'border-box',
};

const fieldErrorStyle: React.CSSProperties = {
    color: 'crimson',
    fontSize: '0.8rem',
    marginTop: '0.25rem',
};

const th: React.CSSProperties = { padding: '0.5rem 0.75rem' };
const td: React.CSSProperties = { padding: '0.5rem 0.75rem', verticalAlign: 'top' };

const smallButton: React.CSSProperties = {
    padding: '0.25rem 0.625rem',
    fontSize: '0.85rem',
    cursor: 'pointer',
};

function buttonStyle(pending: boolean): React.CSSProperties {
    return {
        padding: '0.5rem 1rem',
        fontSize: '0.95rem',
        cursor: pending ? 'progress' : 'pointer',
    };
}
