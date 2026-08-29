/**
 * A long option set as a searchable menu.
 *
 * The Market filter can hold every coin the family trades — 154 on HLP — and
 * inline tags for that many buried the rows under their own filter. This is
 * the official page's dropdown: a trigger showing the current choice, a search
 * field, and a scrolling list.
 *
 * Lifted verbatim out of the vault activity card: the trade screen's market
 * picker needs the identical pill-and-popover control, and the pill's states
 * (label while unset, selection once set) are the part worth sharing.
 */

import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { InputGroup, Popover, PressableFeedback, Typography, useThemeColor } from "heroui-native";
import { ChevronDown, Search } from "lucide-react-native";

import { searchMarkets, type FilterOption } from "@/components/vaults/feedFilters";

/** Re-exported so a call site can type its options without reaching into vaults. */
export type { FilterOption };

/** Above this many options a filter's menu grows a search field. */
const SEARCHABLE_OPTION_LIMIT = 8;

export interface FilterMenuProps {
  label: string;
  options: readonly FilterOption[];
  selected: string;
  onSelect: (value: string) => void;
  /**
   * For a control with no "unset" state — TWAP's view switch, where `active`
   * is a real choice rather than "no filter". Such a pill always shows what
   * it is on, since falling back to the label would hide the current view.
   */
  alwaysShowSelection?: boolean;
}

export function FilterMenu({
  label,
  options,
  selected,
  onSelect,
  alwaysShowSelection = false,
}: FilterMenuProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mutedColor, accentColor] = useThemeColor(["muted", "accent"]);
  const shown = searchMarkets(options, query);
  const current = options.find((option) => option.id === selected);
  const isSet = alwaysShowSelection || selected !== "all";
  // A three-option menu does not need a search field; a 154-market one does.
  const withSearch = options.length > SEARCHABLE_OPTION_LIMIT;

  return (
    // Controlled so a selection can CLOSE it. Uncontrolled, the menu stayed
    // open over the list it had just re-ordered — you chose a sort and then had
    // to dismiss the thing covering the result. Tolerable while this control
    // was buried in the vault activity card; not once it moved onto the markets
    // header. The query resets with the close so a reopen does not inherit a
    // filter the user cannot see.
    <Popover
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setQuery("");
      }}
    >
      {/* A plain View inside the trigger — a nested Button captures the tap. */}
      <Popover.Trigger accessibilityLabel={`${label} filter`}>
        {/* The pill carries the LABEL while unset and the SELECTION once set:
            an unset filter needs to say what it filters, and a set one needs
            to say what it is doing — showing both would be twice the width
            for the same information. */}
        {/* `h-8` — 32pt, EXPLICITLY, because this pill has to stand in a row
            beside `Segment size="sm"` on the portfolio chart and match it. That
            segment measures 2pt group padding + 4pt item padding + a 20pt
            `text-sm` line box + 4 + 2 = 32; this pill's own padding arithmetic
            (`py-1.5` around a 16pt `text-xs` line box) came to 28, and the 4pt
            difference read as a misaligned control rather than a smaller one.

            A fixed height rather than more padding, so the match cannot drift
            if the label's type scale ever changes — and applied here, in the
            shared component, rather than at one call site: 32pt is the design
            system's standard small-control height, and a filter pill should sit
            on it everywhere. */}
        <View
          className={`h-8 flex-row items-center gap-1.5 self-start rounded-full px-3 ${
            isSet ? "bg-accent-soft" : "bg-background"
          }`}
        >
          <Typography.Paragraph
            className={`text-xs font-medium ${isSet ? "text-accent" : "text-muted"}`}
            numberOfLines={1}
          >
            {isSet ? (current?.label ?? label) : label}
          </Typography.Paragraph>
          <ChevronDown size={12} color={isSet ? accentColor : mutedColor} />
        </View>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Overlay />
        <Popover.Content presentation="popover" className="gap-3 bg-background">
          <Popover.ContentBackground className="bg-surface" />
          {withSearch ? (
            <InputGroup>
              <InputGroup.Prefix>
                <Search size={14} color={mutedColor} />
              </InputGroup.Prefix>
              <InputGroup.Input
                placeholder="Search"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="characters"
                autoCorrect={false}
                className="px-4 font-normal"
              />
            </InputGroup>
          ) : null}
          <ScrollView className="max-h-72" keyboardShouldPersistTaps="handled">
            <View className="gap-0.5">
              {shown.map((option) => (
                <PressableFeedback
                  key={option.id}
                  onPress={() => {
                    onSelect(option.id);
                    setIsOpen(false);
                    setQuery("");
                  }}
                  className="rounded-lg px-2 py-2"
                >
                  <Typography.Paragraph
                    className={`text-sm ${option.id === selected ? "font-semibold" : "text-muted font-normal"}`}
                  >
                    {option.label}
                  </Typography.Paragraph>
                </PressableFeedback>
              ))}
            </View>
          </ScrollView>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
