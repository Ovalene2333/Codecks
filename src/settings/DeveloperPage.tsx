import { useEffect, useState } from "react";
import { Waypoints } from "lucide-react";
import { put } from "../api";
import { Button, Field, Group, Row, Section } from "../kit";
import {
  DEFAULT_SESSION_ALIAS_RETENTION_DAYS,
  SESSION_ALIAS_RETENTION_DAYS_MAX,
} from "../../shared/session-alias";
import type { DeckPreferences, Snapshot } from "../types";
import { EmergencyStopSection } from "./EmergencyStopSection";
import type { ConfirmFn } from "./useAgentActions";

export function DeveloperPage({
  snapshot,
  preferences,
  onSaved,
  onToast,
  onConfirm,
  onOpenTool,
}: {
  snapshot: Snapshot;
  preferences?: DeckPreferences;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
  onOpenTool?: (path: string) => void;
}) {
  const currentDays =
    preferences?.aliasRetentionDays ?? DEFAULT_SESSION_ALIAS_RETENTION_DAYS;
  const [days, setDays] = useState(String(currentDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDays(String(currentDays));
  }, [currentDays]);

  const saveRetention = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(days);
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > SESSION_ALIAS_RETENTION_DAYS_MAX
    ) {
      setError(`请输入 0-${SESSION_ALIAS_RETENTION_DAYS_MAX} 的整数`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      onSaved(await put<Snapshot>("/preferences", { aliasRetentionDays: value }));
      onToast("别名保留期已保存");
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Section
        title="deck-api"
        desc="已删除会话的别名回收；活跃会话不受影响。"
      >
        <Group pad>
          <form onSubmit={saveRetention}>
            <Field
              label="别名保留（天）"
              hint="到期后释放别名；0 表示不回收。"
            >
              <div className="dev-alias-form">
                <input
                  className="ui-input"
                  type="number"
                  min={0}
                  max={SESSION_ALIAS_RETENTION_DAYS_MAX}
                  step={1}
                  inputMode="numeric"
                  aria-label="已删除会话的别名保留天数"
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
                <span className="dev-alias-unit">天</span>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  busy={saving}
                  disabled={days === String(currentDays)}
                >
                  保存
                </Button>
              </div>
            </Field>
            {error ? <p className="ui-error">{error}</p> : null}
          </form>
        </Group>
        <Group>
          <Row
            title="协作泳道"
            desc="查看询问、回传与唤醒的完整链路。"
            side={
              onOpenTool ? (
                <Button size="sm" onClick={() => onOpenTool("/deck-api")}>
                  <Waypoints />
                  打开
                </Button>
              ) : undefined
            }
          />
        </Group>
      </Section>
      <EmergencyStopSection
        snapshot={snapshot}
        onSaved={onSaved}
        onToast={onToast}
        onConfirm={onConfirm}
      />
    </>
  );
}
