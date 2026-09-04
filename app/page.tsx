import {
  LifecycleState,
  ItemType,
  CadDocumentType,
  CadDependencyType,
} from "@/app/generated/prisma/enums";
import {
  advanceRevision,
  createCadDependency,
  createCadDocument,
  createEngineeringRevision,
  createItem,
  linkExistingCadDocumentToRevision,
} from "@/app/actions";
import { UploadFileVersion } from "@/app/components/upload-file-version";
import { prisma } from "@/app/lib/prisma";
import { requireDashboardActor, type Actor } from "@/app/lib/authz";
import {
  canCreateSuccessorFrom,
  manualTransitionTargets,
  nextRevisionLetter,
} from "@/app/lib/revisions";
import { signOut } from "@/auth";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

async function getDashboardData(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      users: { orderBy: { name: "asc" } },
      customers: { orderBy: { name: "asc" } },
    },
  });

  if (!organization) {
    return {
      organization: null,
      projects: [],
      items: [],
      revisions: [],
      cadDocuments: [],
      cadDependencies: [],
      cadDocumentCount: 0,
      lifecycleCounts: emptyLifecycleCounts(),
      openRevisions: [],
    };
  }

  const [projects, items, revisions, cadDocuments, cadDependencies] =
    await Promise.all([
      prisma.project.findMany({
        where: { organizationId: organization.id },
        orderBy: { projectNumber: "asc" },
        include: { customer: true },
      }),
      prisma.item.findMany({
        where: { organizationId: organization.id },
        orderBy: { itemNumber: "asc" },
        include: {
          project: true,
          revisions: {
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      prisma.itemRevision.findMany({
        where: { organizationId: organization.id },
        orderBy: [{ item: { itemNumber: "asc" } }, { revision: "asc" }],
        include: {
          item: true,
          createdBy: { select: { name: true, email: true } },
          sourceRevision: { select: { revision: true, lifecycle: true } },
          // CAD documents are associated through the ItemRevisionDocument link,
          // not owned by the revision.
          documentLinks: {
            orderBy: { cadDocument: { documentNumber: "asc" } },
            select: {
              id: true,
              cadDocument: {
                select: {
                  id: true,
                  documentNumber: true,
                  fileName: true,
                  documentType: true,
                  _count: { select: { fileVersions: true } },
                  fileVersions: {
                    orderBy: { versionNumber: "desc" },
                    take: 1,
                    select: {
                      id: true,
                      versionNumber: true,
                      createdAt: true,
                      checksum: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      // All CAD documents in the workspace (for the reference-graph form and
      // "Where used" is derived from the edge list below (distinct parents),
      // so no per-document dependency counts are needed here.
      prisma.cadDocument.findMany({
        where: { organizationId: organization.id },
        orderBy: { documentNumber: "asc" },
        select: {
          id: true,
          fileName: true,
          documentNumber: true,
          documentType: true,
        },
      }),
      // The CAD reference graph edges themselves.
      prisma.cadDependency.findMany({
        where: { organizationId: organization.id },
        orderBy: [
          { parentDocument: { documentNumber: "asc" } },
          { dependencyType: "asc" },
          { childDocument: { documentNumber: "asc" } },
        ],
        select: {
          id: true,
          dependencyType: true,
          parentDocument: {
            select: { id: true, fileName: true, documentNumber: true },
          },
          childDocument: {
            select: {
              id: true,
              fileName: true,
              documentNumber: true,
              documentType: true,
            },
          },
        },
      }),
    ]);

  const lifecycleCounts = revisions.reduce((counts, revision) => {
    counts[revision.lifecycle] += 1;
    return counts;
  }, emptyLifecycleCounts());
  const openRevisions = revisions.filter(
    (revision) =>
      revision.lifecycle !== LifecycleState.RELEASED &&
      revision.lifecycle !== LifecycleState.OBSOLETE &&
      revision.lifecycle !== LifecycleState.SUPERSEDED,
  );

  return {
    organization,
    projects,
    items,
    revisions,
    cadDocuments,
    cadDependencies,
    cadDocumentCount: cadDocuments.length,
    lifecycleCounts,
    openRevisions,
  };
}

function emptyLifecycleCounts() {
  return Object.values(LifecycleState).reduce(
    (counts, state) => ({ ...counts, [state]: 0 }),
    {} as Record<LifecycleState, number>,
  );
}

type DashboardData =
  | ({ status: "ready" } & Awaited<ReturnType<typeof getDashboardData>>)
  | {
      status: "unavailable";
      message: string;
    };

async function loadDashboard(organizationId: string): Promise<DashboardData> {
  try {
    const data = await getDashboardData(organizationId);
    return { status: "ready", ...data };
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The PLM database is not reachable yet.",
    };
  }
}

const lifecycleOrder = [
  LifecycleState.WORKING,
  LifecycleState.IN_REVIEW,
  LifecycleState.APPROVED,
  LifecycleState.RELEASED,
  LifecycleState.SUPERSEDED,
  LifecycleState.OBSOLETE,
];

export default async function Home() {
  const actor = await requireDashboardActor();
  const dashboard = await loadDashboard(actor.organizationId);

  if (dashboard.status === "unavailable") {
    return (
      <main className="min-h-screen bg-stone-100 px-6 py-10 text-slate-950">
        <section className="mx-auto flex max-w-3xl flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
              Arch PLM
            </p>
            <SessionBar actor={actor} />
          </div>
          <h1 className="text-4xl font-semibold tracking-normal">
            The PLM workspace is temporarily unavailable.
          </h1>
          <p className="text-base leading-7 text-slate-700">{dashboard.message}</p>
        </section>
      </main>
    );
  }

  const {
    organization,
    projects,
    items,
    revisions,
    cadDocuments,
    cadDependencies,
    cadDocumentCount,
    lifecycleCounts,
    openRevisions,
  } = dashboard;
  const revisionsWithCad = revisions.filter(
    (revision) => revision.documentLinks.length > 0,
  );

  // Engineering revisions grouped by item (for the lineage / lifecycle view).
  type RevisionRow = (typeof revisions)[number];
  const revisionsByItem = revisions.reduce<
    { item: RevisionRow["item"]; revs: RevisionRow[] }[]
  >((groups, revision) => {
    const group = groups.find((g) => g.item.id === revision.item.id);
    if (group) {
      group.revs.push(revision);
    } else {
      groups.push({ item: revision.item, revs: [revision] });
    }
    return groups;
  }, []);

  // Group dependency edges by parent document for the "references" view.
  type CadEdge = (typeof cadDependencies)[number];
  type DependencyGroup = { parent: CadEdge["parentDocument"]; edges: CadEdge[] };
  const dependencyGroups = cadDependencies.reduce<DependencyGroup[]>(
    (groups, edge) => {
      const existing = groups.find(
        (group) => group.parent.id === edge.parentDocument.id,
      );
      if (existing) {
        existing.edges.push(edge);
      } else {
        groups.push({ parent: edge.parentDocument, edges: [edge] });
      }
      return groups;
    },
    [],
  );

  // "Where used": for each child document, the count of DISTINCT parent CAD
  // documents that reference it. The schema intentionally allows the same
  // parent->child pair with different dependency types (COMPONENT + REFERENCE),
  // so a raw edge/row count would over-report. Derived from the already-fetched
  // edge list — no extra query.
  const whereUsed = Array.from(
    cadDependencies
      .reduce<Map<string, { document: CadEdge["childDocument"]; parents: Set<string> }>>(
        (map, edge) => {
          const entry = map.get(edge.childDocument.id) ?? {
            document: edge.childDocument,
            parents: new Set<string>(),
          };
          entry.parents.add(edge.parentDocument.id);
          map.set(edge.childDocument.id, entry);
          return map;
        },
        new Map(),
      )
      .values(),
  )
    .map((entry) => ({
      document: entry.document,
      parentCount: entry.parents.size,
    }))
    .sort((a, b) => a.document.fileName.localeCompare(b.document.fileName));

  return (
    <main className="min-h-screen bg-stone-100 text-slate-950">
      <section className="border-b border-slate-300 bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-6 py-8 lg:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
                Arch PLM Core
              </p>
              <SessionBar actor={actor} />
            </div>
            <h1 className="mt-3 text-4xl font-semibold tracking-normal">
              {organization?.name ?? "No workspace yet"}
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-7 text-slate-700">
              Engineering item control across customers, projects, permanent item
              identities, and revision lifecycle states.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Projects" value={projects.length} />
            <Metric label="Items" value={items.length} />
            <Metric label="Customers" value={organization?.customers.length ?? 0} />
            <Metric label="Users" value={organization?.users.length ?? 0} />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-6 py-6 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {lifecycleOrder.map((state) => (
              <Metric
                key={state}
                label={formatState(state)}
                value={lifecycleCounts[state]}
              />
            ))}
          </div>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">Item master</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-5 py-3">Item</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Project</th>
                    <th className="px-5 py-3">Latest revision</th>
                    <th className="px-5 py-3">State</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const latestRevision = item.revisions[0];

                    return (
                      <tr key={item.id} className="border-t border-slate-200">
                        <td className="px-5 py-4">
                          <p className="font-semibold">{item.itemNumber}</p>
                          <p className="mt-1 text-slate-600">{item.description}</p>
                        </td>
                        <td className="px-5 py-4">{formatState(item.type)}</td>
                        <td className="px-5 py-4 text-slate-700">
                          {item.project?.projectNumber ?? "Unassigned"}
                        </td>
                        <td className="px-5 py-4">{latestRevision?.revision ?? "-"}</td>
                        <td className="px-5 py-4">
                          {latestRevision ? <StateBadge state={latestRevision.lifecycle} /> : "-"}
                        </td>
                      </tr>
                    );
                  })}
                  {items.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-slate-600" colSpan={5}>
                        No items have been created yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">Engineering revisions</h2>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                {openRevisions.length} open · lifecycle transitions are enforced
                server-side
              </span>
            </div>
            <div className="divide-y divide-slate-200">
              {revisionsByItem.map((group) => (
                <div key={group.item.id} className="px-5 py-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {group.item.itemNumber}
                    <span className="ml-2 font-normal normal-case text-slate-500">
                      {group.item.description}
                    </span>
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {group.revs.map((revision) => (
                      <RevisionCard key={revision.id} revision={revision} />
                    ))}
                  </div>
                </div>
              ))}
              {revisions.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-600">
                  No engineering revisions yet.
                </p>
              ) : null}
            </div>

            {cadDocuments.length > 0 && revisions.length > 0 ? (
              <form
                action={linkExistingCadDocumentToRevision}
                className="grid gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 md:grid-cols-[1fr_1fr_110px]"
              >
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Link existing CAD document → revision
                  <select
                    name="itemRevisionId"
                    required
                    defaultValue={revisions[0]?.id ?? ""}
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {revision.item.itemNumber} Rev {revision.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  CAD document
                  <select
                    name="cadDocumentId"
                    required
                    defaultValue={cadDocuments[0]?.id ?? ""}
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    {cadDocuments.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.fileName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="h-10 self-end rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">
                  Link
                </button>
              </form>
            ) : null}
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">CAD documents</h2>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                {cadDocumentCount} document{cadDocumentCount === 1 ? "" : "s"} in workspace ·
                linked to revisions · file versions independent of the revision
              </span>
            </div>

            <form
              action={createCadDocument}
              className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 md:grid-cols-[1fr_1fr_140px_110px]"
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Item revision
                <select
                  name="itemRevisionId"
                  required
                  defaultValue={revisions[0]?.id ?? ""}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {revisions.length === 0 ? (
                    <option value="">No revisions yet</option>
                  ) : null}
                  {revisions.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {revision.item.itemNumber} Rev {revision.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                File name
                <input
                  name="fileName"
                  required
                  placeholder="10073-MFD-AS210.iam"
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-700"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Type
                <select
                  name="documentType"
                  defaultValue={CadDocumentType.IAM}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {Object.values(CadDocumentType).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="h-10 self-end rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
                disabled={revisions.length === 0}
              >
                Attach
              </button>
            </form>

            <div className="divide-y divide-slate-200">
              {revisionsWithCad.map((revision) => (
                <div key={revision.id} className="px-5 py-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {revision.item.itemNumber} Rev {revision.revision}
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {revision.documentLinks.map((link) => {
                      const cadDocument = link.cadDocument;
                      const latestVersion = cadDocument.fileVersions[0];

                      return (
                        <div
                          key={link.id}
                          className="rounded-md border border-slate-200 px-4 py-3"
                        >
                          <div className="grid gap-3 md:grid-cols-[1fr_90px_120px_150px]">
                            <div>
                              <p className="font-semibold">{cadDocument.fileName}</p>
                              <p className="mt-0.5 text-xs text-slate-500">
                                {cadDocument.documentNumber}
                              </p>
                            </div>
                            <span className="inline-flex h-6 items-center self-center justify-center rounded-full bg-slate-100 px-2 text-xs font-semibold text-slate-700">
                              {cadDocument.documentType}
                            </span>
                            <div className="self-center text-sm text-slate-700">
                              <p>
                                Latest{" "}
                                <span className="font-semibold">
                                  {latestVersion ? `V${latestVersion.versionNumber}` : "—"}
                                </span>
                              </p>
                              <p className="text-xs text-slate-500">
                                {cadDocument._count.fileVersions} version
                                {cadDocument._count.fileVersions === 1 ? "" : "s"}
                              </p>
                            </div>
                            <div className="self-center text-xs text-slate-500">
                              Upload stores real bytes
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2">
                            <UploadFileVersion cadDocumentId={cadDocument.id} />
                            {latestVersion ? (
                              <a
                                href={`/api/file-versions/${latestVersion.id}/content`}
                                className="text-xs font-semibold text-teal-700 underline"
                              >
                                Download V{latestVersion.versionNumber}
                              </a>
                            ) : null}
                            <a
                              href={`/api/cad-documents/${cadDocument.id}/get-latest`}
                              className="text-xs font-semibold text-slate-700 underline"
                            >
                              Get Latest manifest
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {cadDocumentCount === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-600">
                  No CAD documents in this workspace yet. Attaching a document or adding a
                  file version never changes an engineering revision.
                </p>
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">CAD references</h2>
              <span className="text-xs uppercase tracking-wide text-slate-500">
                {cadDependencies.length} relationship
                {cadDependencies.length === 1 ? "" : "s"} · document-to-document ·
                independent of file versions
              </span>
            </div>

            <form
              action={createCadDependency}
              className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 md:grid-cols-[1fr_170px_1fr_110px]"
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Parent CAD document
                <select
                  name="parentDocumentId"
                  required
                  defaultValue={cadDocuments[0]?.id ?? ""}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {cadDocuments.length === 0 ? (
                    <option value="">No CAD documents yet</option>
                  ) : null}
                  {cadDocuments.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.fileName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Relationship
                <select
                  name="dependencyType"
                  defaultValue={CadDependencyType.COMPONENT}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {Object.values(CadDependencyType).map((type) => (
                    <option key={type} value={type}>
                      {formatState(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Child CAD document
                <select
                  name="childDocumentId"
                  required
                  defaultValue={cadDocuments[1]?.id ?? ""}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {cadDocuments.length === 0 ? (
                    <option value="">No CAD documents yet</option>
                  ) : null}
                  {cadDocuments.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.fileName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="h-10 self-end rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
                disabled={cadDocuments.length < 2}
              >
                Link
              </button>
            </form>

            <div className="grid gap-6 px-5 py-4 lg:grid-cols-[1fr_260px]">
              <div className="flex flex-col gap-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  References / uses
                </p>
                {dependencyGroups.map((group) => (
                  <div key={group.parent.id}>
                    <p className="font-semibold">{group.parent.fileName}</p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {group.edges.map((edge) => (
                        <li key={edge.id} className="text-sm text-slate-700">
                          <span className="font-mono text-xs uppercase text-teal-700">
                            {edge.dependencyType}
                          </span>{" "}
                          → {edge.childDocument.fileName}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {cadDependencies.length === 0 ? (
                  <p className="text-sm text-slate-600">
                    No CAD relationships recorded yet.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Where used
                </p>
                {whereUsed.map((entry) => (
                  <div key={entry.document.id} className="text-sm text-slate-700">
                    <span className="font-semibold">{entry.document.fileName}</span>
                    <span className="text-slate-500">
                      {" "}
                      · {entry.parentCount} parent
                      {entry.parentCount === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
                {whereUsed.length === 0 ? (
                  <p className="text-sm text-slate-600">Nothing referenced yet.</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <section className="rounded-lg border border-slate-300 bg-white p-5">
            <h2 className="text-lg font-semibold">Create item</h2>
            <form action={createItem} className="mt-5 flex flex-col gap-4">
              <Field label="Item number" name="itemNumber" placeholder="10073-MFD-BR018" />
              <Field label="Description" name="description" placeholder="Bearing support bracket" />
              <label className="flex flex-col gap-2 text-sm font-medium">
                Type
                <select
                  name="type"
                  defaultValue={ItemType.PART}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  {Object.values(ItemType).map((type) => (
                    <option key={type} value={type}>
                      {formatState(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Project
                <select
                  name="projectId"
                  defaultValue={projects[0]?.id ?? ""}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="">Unassigned</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.projectNumber} - {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-[92px_1fr] gap-3">
                <Field label="Rev" name="revision" placeholder="A" />
                <Field
                  label="Revision note"
                  name="revisionDescription"
                  placeholder="Initial design baseline"
                />
              </div>
              <button className="h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800">
                Add item
              </button>
            </form>
          </section>

          <section className="rounded-lg border border-slate-300 bg-white p-5">
            <h2 className="text-lg font-semibold">Projects</h2>
            <div className="mt-4 flex flex-col gap-3">
              {projects.map((project) => (
                <div key={project.id} className="border-b border-slate-200 pb-3 last:border-0">
                  <p className="font-semibold">{project.projectNumber}</p>
                  <p className="text-sm text-slate-700">{project.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
                    {project.customer?.name ?? "No customer"}
                  </p>
                </div>
              ))}
              {projects.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No projects exist in this workspace yet.
                </p>
              ) : null}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function RevisionCard({
  revision,
}: {
  revision: {
    id: string;
    revision: string;
    lifecycle: LifecycleState;
    createdBy: { name: string; email: string } | null;
    sourceRevision: { revision: string; lifecycle: LifecycleState } | null;
    documentLinks: { id: string; cadDocument: { id: string; fileName: string } }[];
  };
}) {
  const transitionTargets = manualTransitionTargets(revision.lifecycle);
  const canCreateNext = canCreateSuccessorFrom(revision.lifecycle);

  let nextRev: string | null = null;
  try {
    nextRev = nextRevisionLetter(revision.revision);
  } catch {
    nextRev = null; // revision Z – no successor supported yet
  }

  return (
    <div className="rounded-md border border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">Rev {revision.revision}</span>
        <StateBadge state={revision.lifecycle} />
        {revision.sourceRevision ? (
          <span className="text-xs text-slate-500">
            from Rev {revision.sourceRevision.revision}
          </span>
        ) : null}
        <span className="text-xs text-slate-500">
          {revision.documentLinks.length} CAD document
          {revision.documentLinks.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-slate-400">
          {revision.createdBy
            ? `by ${revision.createdBy.name || revision.createdBy.email}`
            : "creator unknown"}
        </span>
      </div>

      {transitionTargets.length > 0 ? (
        <form
          action={advanceRevision}
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="revisionId" value={revision.id} />
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Move to
            <select
              name="lifecycle"
              defaultValue={transitionTargets[0]}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              {transitionTargets.map((state) => (
                <option key={state} value={state}>
                  {formatState(state)}
                </option>
              ))}
            </select>
          </label>
          <button className="h-9 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white transition hover:bg-teal-800">
            Update
          </button>
        </form>
      ) : null}

      {canCreateNext ? (
        nextRev ? (
          <form
            action={createEngineeringRevision}
            className="mt-3 rounded-md bg-slate-50 p-3"
          >
            <input type="hidden" name="sourceRevisionId" value={revision.id} />
            <p className="text-xs font-semibold text-slate-700">
              Create Rev {nextRev} from Rev {revision.revision}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              The new revision starts as Working. Carried-forward CAD documents
              are the same logical documents — all their file versions and
              references stay shared. Nothing is copied.
            </p>
            <label className="mt-2 flex flex-col gap-1 text-xs font-medium text-slate-600">
              CAD documents
              <select
                name="carryForwardMode"
                defaultValue="all"
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="all">Carry forward all</option>
                <option value="selected">Carry forward only the checked ones</option>
                <option value="none">Start with none</option>
              </select>
            </label>
            {revision.documentLinks.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {revision.documentLinks.map((link) => (
                  <label
                    key={link.id}
                    className="flex items-center gap-2 text-xs text-slate-700"
                  >
                    <input
                      type="checkbox"
                      name="carryForwardDocumentId"
                      value={link.cadDocument.id}
                      defaultChecked
                    />
                    {link.cadDocument.fileName}
                  </label>
                ))}
                <span className="text-xs text-slate-400">
                  Checkboxes apply only in “only the checked ones” mode.
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                No CAD documents linked to this revision.
              </p>
            )}
            <label className="mt-2 flex flex-col gap-1 text-xs font-medium text-slate-600">
              Description (optional)
              <input
                name="description"
                placeholder="defaults to the source revision's description"
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-700"
              />
            </label>
            <button className="mt-3 h-9 rounded-md bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800">
              Create Rev {nextRev}
            </button>
          </form>
        ) : (
          <p className="mt-3 text-xs text-slate-500">
            Revisions beyond Z are not supported yet.
          </p>
        )
      ) : null}
    </div>
  );
}

function SessionBar({ actor }: { actor: Actor }) {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-600">
      <span className="text-right leading-tight">
        <span className="block font-semibold text-slate-800">
          {actor.name || actor.email}
        </span>
        <span className="block uppercase tracking-wide text-slate-500">
          {formatState(actor.role)}
        </span>
      </span>
      <form action={signOutAction}>
        <button className="h-8 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: LifecycleState }) {
  const tone =
    state === LifecycleState.RELEASED
      ? "bg-emerald-100 text-emerald-800"
      : state === LifecycleState.IN_REVIEW
        ? "bg-amber-100 text-amber-800"
        : state === LifecycleState.APPROVED
          ? "bg-teal-100 text-teal-800"
          : "bg-slate-100 text-slate-700";

  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {formatState(state)}
    </span>
  );
}

function Field({
  label,
  name,
  placeholder,
}: {
  label: string;
  name: string;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium">
      {label}
      <input
        className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-teal-700"
        name={name}
        placeholder={placeholder}
        required
      />
    </label>
  );
}

function formatState(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
