/**
 * The connection, made visible — the body of the Account screen's Connection
 * section (`AccountSection` supplies the surface, the title, and the collapsed
 * measure, so this file starts at the gauge).
 *
 * The centrepiece is the **weight gauge**: Hyperliquid allows 1,200 request
 * weight per minute per IP, shared by every feature of this app (and any other
 * client on the network), and until now the only sign of pressure was a
 * deferred screen. The gauge shows the trailing-minute spend so "why is this
 * section deferred" has a visible answer. Green under half, warning from 50%,
 * danger from 85% — the thresholds `accountView.budgetTone` documents.
 *
 * The reading itself arrives as a prop from `useHealthTick`, which the screen
 * owns: the collapsed header shows the same two numbers, and two independent
 * 2 s polls of the same fields would drift against each other.
 *
 * The five device checks below it are the Phase-14 probes (see `probes.ts`).
 * Tap a row to re-run one; the header button runs them all, sequentially, so
 * a hang has an owner.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { Button, PressableFeedback, Spinner, Typography, useThemeColor } from "heroui-native";
import { ProgressCircle } from "heroui-native-pro";
import { Check, X } from "lucide-react-native";

import { budgetTone } from "@/components/account/accountView";
import { InfoRow } from "@/components/account/primitives";
import { PROBE_IDLE, PROBES, type Probe, type ProbeState } from "@/components/account/probes";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { toHlError } from "@/hyperliquid/core/errors";

export function HealthCard({
  used,
  resumeNote,
}: {
  /** Trailing-minute request weight, polled once by the screen. */
  used: number;
  /** The app-state policy's last decision, already worded by the screen. */
  resumeNote: string;
}): JSX.Element {
  const successColor = useThemeColor("success");
  const dangerColor = useThemeColor("danger");
  const warningColor = useThemeColor("warning");

  const tone = budgetTone(used, weightBudget.capacity());
  const gaugeColor =
    tone === "danger" ? dangerColor : tone === "warning" ? warningColor : successColor;

  const [results, setResults] = useState<Record<string, ProbeState>>({});
  const [busy, setBusy] = useState(false);

  const runProbe = useCallback(async (probe: Probe) => {
    setResults((prev) => ({ ...prev, [probe.key]: { status: "running", detail: "…" } }));
    try {
      const outcome = await probe.run();
      setResults((prev) => ({
        ...prev,
        [probe.key]: { status: outcome.ok ? "pass" : "fail", detail: outcome.detail },
      }));
    } catch (caught) {
      const hl = toHlError(caught);
      setResults((prev) => ({
        ...prev,
        [probe.key]: { status: "fail", detail: `${hl.code}: ${hl.message}` },
      }));
    }
  }, []);

  const runAll = useCallback(async () => {
    setBusy(true);
    try {
      // Sequential on purpose: a parallel run makes it impossible to say
      // which probe is responsible for a hang.
      for (const probe of PROBES) await runProbe(probe);
    } finally {
      setBusy(false);
    }
  }, [runProbe]);

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-5">
        <ProgressCircle value={used} minValue={0} maxValue={weightBudget.capacity()} size="lg">
          <ProgressCircle.Indicator fillColor={gaugeColor} />
          <ProgressCircle.ValueLabel className="tabular-nums font-semibold">
            {String(used)}
          </ProgressCircle.ValueLabel>
        </ProgressCircle>
        <View className="flex-1 gap-1">
          <Typography.Paragraph className="font-medium">Request budget</Typography.Paragraph>
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {used} of {weightBudget.capacity()} weight spent in the last minute. The whole device
            shares it; sections defer rather than exceed it.
          </Typography.Paragraph>
        </View>
      </View>

      <InfoRow label="On resume" value={resumeNote} />

      <View className="gap-1">
        <View className="flex-row items-center justify-between">
          <Typography.Paragraph className="font-medium">Device checks</Typography.Paragraph>
          <Button size="sm" variant="tertiary" onPress={() => void runAll()} isDisabled={busy}>
            <Button.Label className="font-medium">Run all</Button.Label>
          </Button>
        </View>
        {PROBES.map((probe) => {
          const state = results[probe.key] ?? PROBE_IDLE;
          return (
            <PressableFeedback
              key={probe.key}
              onPress={() => void runProbe(probe)}
              isDisabled={busy || state.status === "running"}
            >
              <View className="gap-0.5 py-1.5">
                <View className="flex-row items-center gap-2">
                  <ProbeMarker state={state} />
                  <Typography.Paragraph className="flex-1 text-sm font-normal">
                    {probe.label}
                  </Typography.Paragraph>
                </View>
                <Typography.Paragraph
                  className="pl-6 text-xs text-muted font-normal"
                  numberOfLines={2}
                >
                  {state.detail}
                </Typography.Paragraph>
              </View>
            </PressableFeedback>
          );
        })}
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Tap a check to run it alone. The socket check opens the shared transport; starting a
          session afterwards closes it again — that is expected.
        </Typography.Paragraph>
      </View>
    </View>
  );
}

function ProbeMarker({ state }: { state: ProbeState }): JSX.Element {
  const successColor = useThemeColor("success");
  const dangerColor = useThemeColor("danger");
  const mutedColor = useThemeColor("muted");

  if (state.status === "running") return <Spinner size="sm" />;
  if (state.status === "pass") return <Check size={16} color={successColor} />;
  if (state.status === "fail") return <X size={16} color={dangerColor} />;
  return (
    <View className="h-4 w-4 items-center justify-center">
      <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: mutedColor }} />
    </View>
  );
}
