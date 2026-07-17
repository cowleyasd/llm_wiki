import { useDeepWikiStore } from "@/stores/deepwiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { retryDeepWikiQuery } from "@/lib/deepwiki-channel"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { RefreshCw, AlertCircle, Loader2, CheckCircle2, X } from "lucide-react"

export function DeepWikiPanel() {
  const { t } = useTranslation()
  const records = useDeepWikiStore((s) => s.records)
  const setPanelOpen = useDeepWikiStore((s) => s.setPanelOpen)
  const project = useWikiStore((s) => s.project)
  const searchConfig = useWikiStore((s) => s.searchApiConfig)

  const handleRetry = async (id: string) => {
    if (!project) return
    const { resolveSearchConfig } = await import("@/lib/web-search")
    const resolved = resolveSearchConfig(searchConfig)
    if (!resolved.deepWiki) return
    const llmConfig = useWikiStore.getState().llmConfig
    void retryDeepWikiQuery(project.path, id, llmConfig, resolved.deepWiki, project.id)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">{t("deepwiki.title", "DeepWiki Queries")}</span>
        <button
          onClick={() => setPanelOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {records.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">{t("deepwiki.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((r) => (
              <li key={r.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium" title={r.topic}>{r.topic}</span>
                  <StatusBadge status={r.status} />
                </div>
                {r.status === "failed" && r.error && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate text-red-500" title={r.error}>{r.error}</span>
                    <Button size="sm" variant="outline" className="h-6 shrink-0 gap-1 text-[11px]" onClick={() => void handleRetry(r.id)}>
                      <RefreshCw className="h-3 w-3" />
                      {t("deepwiki.retry", "Retry")}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === "ingested")
    return (
      <span className="flex shrink-0 items-center gap-1 text-emerald-500">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t("deepwiki.statusIngested")}
      </span>
    )
  if (status === "failed")
    return (
      <span className="flex shrink-0 items-center gap-1 text-red-500">
        <AlertCircle className="h-3.5 w-3.5" />
        {t("deepwiki.statusFailed")}
      </span>
    )
  if (status === "searching")
    return (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("deepwiki.statusSearching")}
      </span>
    )
  if (status === "prompt_ready")
    return (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("deepwiki.statusPromptReady")}
      </span>
    )
  return null
}
