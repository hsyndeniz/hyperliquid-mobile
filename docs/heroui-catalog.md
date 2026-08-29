# HeroUI component catalog

**Generated from the installed packages — regenerate rather than hand-edit.**
`heroui-native` 1.0.8 · `heroui-native-pro` 1.0.0-beta.10

A component marked ✅ is already imported somewhere in `src/` and has therefore
been rendered on a device at least once. Anything unmarked is unproven in this
codebase — read its `.types` file and verify on the simulator before relying on
it (`heroui-native-pro` is a beta; APIs move between releases).

Regenerate after any version bump:

```bash
python3 scripts/gen-heroui-catalog.py
```

## Choosing a component — quick routes

| Need                                 | Reach for                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money amount entry                   | Pro `NumberPad` (+ our `amountEntry.ts`/`acceptDecimalEdit` filter — and remount the pad on a REJECTED keystroke: its internal value ref advances before `onValueChange`, so an ignored proposal desyncs it; see `NumericEditorSheet`'s `padEpoch`) |
| Proportion of a balance, interactive | Core `Slider` (Track/Fill/Thumb; controlled `value`/`onChange`)                                                                                                                                                                                     |
| Proportion, display-only             | Pro `ProgressBar` / `ProgressCircle`                                                                                                                                                                                                                |
| Irreversible commit                  | Pro `SlideButton` (danger variant, `autoReset={false}`)                                                                                                                                                                                             |
| Confirm sheet / modal                | Core `Dialog` (controlled `isOpen`; **`Dialog.Close` is a round icon button — use a plain `Button` for text actions**)                                                                                                                              |
| Inline warning/error block           | Core `Alert` (`status`: default/accent/success/warning/danger)                                                                                                                                                                                      |
| Field with prefix/suffix             | Core `InputGroup` (`.Prefix`/`.Input`/`.Suffix`)                                                                                                                                                                                                    |
| Validation message                   | Core `FieldError` (`isInvalid`-gated, animates in/out)                                                                                                                                                                                              |
| Choice chips / tabs                  | Core `Tabs`, `Segment` is **Pro**                                                                                                                                                                                                                   |
| Token/asset lists                    | Core `ListGroup`; picker → Core `Select` or Pro `Autocomplete` (`presentation="dialog"`)                                                                                                                                                            |
| Numbers that roll                    | `number-flow-react-native` INSIDE Pro `NumberValue`'s render-fn (NumberValue itself is a static formatter — its types say "no intrinsic animation")                                                                                                 |
| Progress through steps               | Pro `Stepper`                                                                                                                                                                                                                                       |

## heroui-native 1.0.8

### `Accordion` ✅

- `AccordionBackgroundProps`: `className`
- `AccordionIndicatorIconProps`: `size`, `color`
- `AccordionRootProps`: `children`, `variant`, `hideSeparator`, `className`, `classNames`, `styles`, `animation`, `background`
- `AccordionItemRenderProps`: `isExpanded`, `value`
- `AccordionItemProps`: `children`, `className`
- `AccordionTriggerProps`: `children`, `className`
- `AccordionIndicatorProps`: `children`, `className`, `iconProps`, `animation`, `isAnimatedStyleActive`
- `AccordionContentProps`: `children`, `className`, `animation`

### `Alert` ✅

- **Sub-components:** `.Background`, `.Indicator`, `.Content`, `.Title`, `.Description`
- `AlertBackgroundProps`: `className`
- `AlertIconProps`: `size`, `color`
- `AlertRootProps`: `children`, `className`, `background`
- `AlertIndicatorProps`: `children`, `className`, `iconProps`
- `AlertContentProps`: `children`, `className`
- `AlertTitleProps`: `children`, `className`
- `AlertDescriptionProps`: `children`, `className`

### `Avatar` ✅

- **Sub-components:** `.Image`, `.Fallback`, `.Background`
- `AvatarRootProps`: `size`, `variant`, `color`, `className`, `animation`, `background`
- `AvatarBackgroundProps`: `className`
- `AvatarImageProps`: `(all of | (AnimatedProps<ImageProps> &)`
- `AvatarFallbackProps`: `delayMs`, `color`, `className`, `classNames`, `styles`, `container`, `text`, `textProps`, `iconProps`, `animation`

### `BottomSheet`

- **Sub-components:** `.Trigger`, `.Portal`, `.Overlay`, `.Content`, `.Background`, `.Close`, `.Title`, `.Description`
- `BottomSheetBackgroundProps`: `className`
- `BottomSheetRootProps`: `children`, `animation`
- `BottomSheetTriggerProps`: `children`
- `BottomSheetPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `children`
- `BottomSheetOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`, `variant`, `blurViewProps`
- `BottomSheetContentProps`: `(all of Partial<BottomSheetProps>,
BaseBottomSheetContentProps)`
- `BottomSheetTitleProps`: `className`
- `BottomSheetDescriptionProps`: `className`

### `Button` ✅

- **Sub-components:** `.Label`, `.Background`
- `ButtonBackgroundProps`: `children`, `className`
- `ButtonLabelProps`: `children`, `className`

### `Card` ✅

- **Sub-components:** `.Header`, `.Body`, `.Footer`, `.Title`, `.Description`
- `CardRootProps`: `(all of SurfaceRootProps)`
- `CardHeaderProps`: `children`, `className`
- `CardBodyProps`: `children`, `className`
- `CardFooterProps`: `children`, `className`
- `CardTitleProps`: `children`, `className`
- `CardDescriptionProps`: `children`, `className`

### `Checkbox` ✅

- **Sub-components:** `.Indicator`, `.Background`
- `CheckboxIndicatorIconProps`: `size`, `strokeWidth`, `color`, `enterDuration`, `exitDuration`
- `CheckboxRenderProps`: `isSelected`, `isInvalid`, `isDisabled`
- `CheckboxProps`: `children`, `variant`, `className`, `animation`, `isAnimatedStyleActive`, `background`
- `CheckboxBackgroundProps`: `className`
- `CheckboxIndicatorProps`: `children`, `className`, `iconProps`, `animation`, `isAnimatedStyleActive`

### `Chip` ✅

- **Sub-components:** `.Label`, `.Background`
- `ChipProps`: `children`, `variant`, `size`, `color`, `className`, `animation`, `background`
- `ChipBackgroundProps`: `className`
- `ChipLabelProps`: `children`, `className`

### `CloseButton`

- `CloseButtonIconProps`: `size`, `color`
- `CloseButtonProps`: `iconProps`

### `ControlField`

- **Sub-components:** `.Indicator`
- `ControlFieldProps`: `children`, `className`, `isSelected`, `isDisabled`, `isInvalid`, `isRequired`, `onSelectedChange`, `animation`
- `ControlFieldIndicatorProps`: `children`, `className`, `variant`

### `Description`

- `DescriptionProps`: `children`, `isInvalid`, `isDisabled`, `hideOnInvalid`, `className`, `nativeID`, `animation`

### `Dialog` ✅

- **Sub-components:** `.Trigger`, `.Portal`, `.Overlay`, `.Content`, `.ContentBackground`, `.Close`, `.Title`, `.Description`
- `DialogContentBackgroundProps`: `className`
- `DialogRootProps`: `children`, `animation`
- `DialogTriggerProps`: `children`
- `DialogPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `className`, `style`, `children`
- `DialogOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`, `variant`, `blurViewProps`
- `DialogContentProps`: `className`, `children`, `background`, `animation`, `isSwipeable`
- `DialogTitleProps`: `className`
- `DialogDescriptionProps`: `className`

### `FieldError` ✅

- `FieldErrorRootProps`: `children`, `isInvalid`, `className`, `classNames`, `styles`, `container`, `text`, `textProps`, `animation`

### `GlassView`

- `GlassViewProps`: `intensity`, `tint`, `fallbackColor`, `forceFallbackColor`, `className`

### `Input` ✅

- **Sub-components:** `.Background`
- `InputBackgroundProps`: `className`, `fallbackColor`
- `InputProps`: `isInvalid`, `isDisabled`, `variant`, `className`, `containerClassName`, `background`, `selectionColorClassName`, `placeholderColorClassName`

### `InputGroup` ✅

- **Sub-components:** `.Prefix`, `.Suffix`, `.Input`
- `InputGroupProps`: `children`, `className`, `isDisabled`, `animation`
- `InputGroupDecoratorBaseProps`: `children`, `className`, `isDecorative`
- `InputGroupPrefixProps`: `(all of InputGroupDecoratorBaseProps)`
- `InputGroupSuffixProps`: `(all of InputGroupDecoratorBaseProps)`
- `InputGroupInputProps`: `(all of InputProps)`

### `InputOtp`

- **Sub-components:** `.Group`, `.Slot`, `.SlotBackground`, `.SlotPlaceholder`, `.SlotValue`, `.SlotCaret`, `.Separator`
- `InputOTPGroupRenderProps`: `slots`, `maxLength`, `value`, `isFocused`, `isDisabled`, `isInvalid`
- `InputOTPRootProps`: `className`, `animation`
- `InputOTPGroupProps`: `className`, `children`
- `InputOTPSlotBackgroundProps`: `className`, `fallbackColor`
- `InputOTPSlotProps`: `variant`, `className`, `background`
- `InputOTPSlotPlaceholderProps`: `children`, `className`
- `InputOTPSlotValueProps`: `children`, `className`, `animation`
- `InputOTPSlotCaretProps`: `className`, `animation`, `isAnimatedStyleActive`
- `InputOTPSeparatorProps`: `className`

### `Label`

- **Sub-components:** `.Text`
- `LabelProps`: `isRequired`, `isInvalid`, `className`, `animation`
- `LabelTextProps`: `className`, `classNames`, `styles`

### `LinkButton`

- **Sub-components:** `.Label`

### `ListGroup`

- **Sub-components:** `.Item`, `.ItemPrefix`, `.ItemContent`, `.ItemTitle`, `.ItemDescription`, `.ItemSuffix`
- `ListGroupRootProps`: `children`, `variant`, `className`
- `ListGroupItemProps`: `children`, `className`
- `ListGroupIconProps`: `size`, `color`
- `ListGroupItemPrefixProps`: `children`, `className`
- `ListGroupItemContentProps`: `children`, `className`
- `ListGroupItemTitleProps`: `children`, `className`
- `ListGroupItemDescriptionProps`: `children`, `className`
- `ListGroupItemSuffixProps`: `children`, `className`, `iconProps`

### `Menu`

- **Sub-components:** `.Trigger`, `.Portal`, `.Overlay`, `.Content`, `.ContentBackground`, `.Close`, `.Group`, `.Label`, `.Item`, `.ItemTitle`, `.ItemDescription`, `.ItemIndicator`
- `MenuContentBackgroundProps`: `className`
- `MenuRootProps`: `children`, `animation`
- `MenuTriggerProps`: `children`, `className`
- `MenuPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `className`, `children`
- `MenuOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`
- `MenuContentPopoverProps`: `presentation`, `className`, `children`, `background`, `animation`
- `MenuContentBottomSheetProps`: `presentation`
- `MenuGroupProps`: `className`, `children`
- `MenuLabelProps`: `className`
- `MenuItemRenderProps`: `isSelected`, `isDisabled`, `isPressed`, `variant`
- `MenuItemProps`: `className`, `animation`, `isAnimatedStyleActive`, `children`
- `MenuItemTitleProps`: `className`
- `MenuItemDescriptionProps`: `className`
- `MenuItemIndicatorIconProps`: `size`, `color`
- `MenuItemIndicatorProps`: `className`, `variant`, `iconProps`

### `Popover` ✅

- **Sub-components:** `.Trigger`, `.Portal`, `.Overlay`, `.Content`, `.ContentBackground`, `.Arrow`, `.Close`, `.Title`, `.Description`
- `PopoverRootProps`: `children`, `animation`
- `PopoverTriggerProps`: `children`, `className`
- `PopoverPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `className`, `children`
- `PopoverOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`
- `PopoverContentBackgroundProps`: `className`
- `PopoverContentPopoverProps`: `presentation`, `className`, `children`, `background`, `animation`
- `PopoverContentBottomSheetProps`: `presentation`
- `PopoverTitleProps`: `className`
- `PopoverDescriptionProps`: `className`
- `PopoverArrowProps`: `children`, `style`, `className`, `height`, `width`, `fill`, `stroke`, `strokeWidth`, `strokeBaselineInset`, `placement`

### `PressableFeedback` ✅

- **Sub-components:** `.Scale`, `.Highlight`, `.Ripple`
- `PressableFeedbackProps`: `isDisabled`, `children`, `className`, `animation`, `isAnimatedStyleActive`, `asChild`
- `PressableFeedbackScaleProps`: `className`, `animation`, `isAnimatedStyleActive`
- `PressableFeedbackHighlightProps`: `className`, `animation`, `isAnimatedStyleActive`
- `PressableFeedbackRippleProps`: `className`, `classNames`, `styles`, `animation`, `isAnimatedStyleActive`

### `Radio`

- **Sub-components:** `.Indicator`, `.IndicatorThumb`, `.IndicatorBackground`
- `RadioRenderProps`: `isSelected`, `isDisabled`, `isInvalid`
- `RadioProps`: `children`, `className`, `animation`
- `RadioIndicatorProps`: `children`, `className`, `background`
- `RadioIndicatorBackgroundProps`: `className`
- `RadioIndicatorThumbProps`: `className`, `animation`, `isAnimatedStyleActive`

### `RadioGroup`

- **Sub-components:** `.Item`
- `RadioGroupProps`: `children`, `className`, `animation`
- `RadioGroupItemRenderProps`: `isSelected`, `isDisabled`, `isInvalid`
- `RadioGroupItemProps`: `children`, `isInvalid`, `variant`, `className`

### `ScrollShadow`

- `LinearGradientProps`: `colors`, `locations`, `start`, `end`, `style`
- `ScrollShadowProps`: `children`, `size`, `orientation`, `visibility`, `color`, `isEnabled`, `className`, `LinearGradientComponent`, `animation`

### `SearchField`

- **Sub-components:** `.Group`, `.SearchIcon`, `.Input`, `.ClearButton`
- `SearchFieldProps`: `children`, `value`, `onChange`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`
- `SearchFieldGroupProps`: `children`, `className`
- `SearchFieldSearchIconIconProps`: `size`, `color`
- `SearchFieldSearchIconProps`: `children`, `className`, `iconProps`
- `SearchFieldInputProps`: `(all of Omit<InputProps, 'value' | 'onChangeText'>)`
- `SearchFieldClearButtonIconProps`: `size`, `color`
- `SearchFieldClearButtonProps`: `iconProps`

### `Select` ✅

- **Sub-components:** `.Trigger`, `.TriggerBackground`, `.TriggerIndicator`, `.Value`, `.Portal`, `.Overlay`, `.Content`, `.ContentBackground`, `.Item`, `.ItemLabel`, `.ItemDescription`, `.ItemIndicator`, `.ListLabel`, `.Close`
- `SelectContentBackgroundProps`: `className`
- `SelectRootProps`: `children`, `className`, `isOpen`, `isDefaultOpen`, `animation`
- `SelectTriggerBackgroundProps`: `className`
- `SelectTriggerProps`: `variant`, `children`, `className`, `background`
- `SelectTriggerIndicatorIconProps`: `size`, `color`
- `SelectTriggerIndicatorProps`: `children`, `className`, `style`, `iconProps`, `animation`, `isAnimatedStyleActive`
- `SelectPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `className`, `children`
- `SelectOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`
- `SelectContentPopoverProps`: `className`, `children`, `background`, `presentation`, `animation`
- `SelectContentBottomSheetProps`: `presentation`
- `SelectContentDialogProps`: `classNames`, `styles`, `children`, `background`, `presentation`, `animation`, `isSwipeable`
- `SelectValueProps`: `className`
- `SelectListLabelProps`: `className`
- `SelectItemRenderProps`: `isSelected`, `value`, `isDisabled`
- `SelectItemProps`: `className`, `children`
- `SelectItemLabelProps`: `className`
- `SelectItemDescriptionProps`: `className`
- `SelectItemIndicatorIconProps`: `size`, `color`
- `SelectItemIndicatorProps`: `className`, `iconProps`

### `Separator`

- `SeparatorProps`: `variant`, `orientation`, `thickness`, `className`

### `Skeleton` ✅

- `SkeletonProps`: `children`, `isLoading`, `variant`, `animation`, `isAnimatedStyleActive`, `className`

### `SkeletonGroup`

- **Sub-components:** `.Item`
- `SkeletonGroupRootProps`: `isSkeletonOnly`, `style`
- `SkeletonGroupItemProps`: `(all of SkeletonProps)`

### `Slider` ✅

- **Sub-components:** `.Output`, `.Track`, `.TrackBackground`, `.Fill`, `.Thumb`
- `SliderProps`: `className`, `animation`
- `SliderOutputProps`: `className`, `classNames`, `textProps`
- `SliderTrackProps`: `className`, `background`
- `SliderTrackBackgroundProps`: `className`
- `SliderFillProps`: `className`
- `SliderThumbProps`: `isDisabled`, `animation`, `className`, `classNames`, `styles`

### `Spinner` ✅

- **Sub-components:** `.Indicator`
- `SpinnerProps`: `children`, `size`, `color`, `isLoading`, `className`, `animation`
- `SpinnerIconProps`: `width`, `height`, `color`
- `SpinnerIndicatorProps`: `children`, `iconProps`, `className`, `animation`, `isAnimatedStyleActive`

### `SubMenu`

- **Sub-components:** `.Background`, `.Trigger`, `.TriggerIndicator`, `.Content`
- `SubMenuBackgroundProps`: `className`
- `SubMenuRootProps`: `children`, `className`, `background`, `animation`
- `SubMenuTriggerProps`: `className`, `children`
- `SubMenuTriggerIndicatorIconProps`: `size`, `color`
- `SubMenuTriggerIndicatorProps`: `children`, `className`, `iconProps`, `animation`, `isAnimatedStyleActive`
- `SubMenuContentProps`: `className`, `children`

### `Surface` ✅

- **Sub-components:** `.Background`
- `SurfaceBackgroundProps`: `className`
- `SurfaceRootProps`: `children`, `variant`, `className`, `animation`, `asChild`, `background`

### `Switch`

- **Sub-components:** `.Thumb`, `.StartContent`, `.EndContent`, `.Background`
- `SwitchRenderProps`: `isSelected`, `isDisabled`
- `SwitchProps`: `children`, `isDisabled`, `className`, `animation`, `isAnimatedStyleActive`, `background`
- `SwitchBackgroundProps`: `className`
- `SwitchThumbProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`
- `SwitchContentProps`: `children`, `className`

### `Tabs` ✅

- **Sub-components:** `.List`, `.ListBackground`, `.ScrollView`, `.Trigger`, `.Label`, `.Indicator`, `.Separator`, `.Content`
- `TabsProps`: `className`, `children`, `variant`, `animation`
- `TabsListProps`: `className`, `children`, `background`
- `TabsListBackgroundProps`: `className`
- `TabsScrollViewProps`: `className`, `contentContainerClassName`, `children`, `scrollAlign`
- `TabsTriggerRenderProps`: `isSelected`, `value`, `isDisabled`
- `TabsTriggerProps`: `value`, `isDisabled`, `className`, `children`
- `TabsLabelProps`: `className`, `children`
- `TabsIndicatorProps`: `className`, `children`, `animation`, `isAnimatedStyleActive`
- `TabsSeparatorProps`: `betweenValues`, `isAlwaysVisible`, `animation`, `isAnimatedStyleActive`, `className`, `children`
- `TabsContentProps`: `value`, `className`, `children`

### `TagGroup`

- **Sub-components:** `.List`, `.Item`, `.ItemBackground`, `.ItemLabel`, `.ItemRemoveButton`
- `TagRenderProps`: `isSelected`, `isDisabled`
- `TagGroupProps`: `size`, `variant`, `className`, `animation`
- `TagGroupListProps`: `children`, `className`, `renderEmptyState`
- `TagGroupItemBackgroundProps`: `className`
- `TagGroupItemProps`: `children`, `className`, `background`
- `TagGroupItemLabelProps`: `children`, `className`
- `TagRemoveButtonIconProps`: `size`, `color`
- `TagGroupItemRemoveButtonProps`: `children`, `className`, `iconProps`

### `Typography` ✅

- **Sub-components:** `.Heading`, `.Paragraph`, `.Code`
- `TextRootProps`: `type`, `align`, `color`, `weight`, `truncate`, `className`, `children`
- `TextHeadingProps`: `type`
- `TextParagraphProps`: `type`
- `TextCodeProps`: `(all of Omit<TextRootProps, 'type'>)`

### `TextArea`

- `TextAreaProps`: `(all of InputProps)`

### `TextField`

- `TextFieldRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`

### `ThemeBackground`

- `ThemeBackgroundProps`: `className`, `fallbackColor`, `forceFallbackColor`
- `ThemeBackgroundContentProps`: `fallbackColor`, `forceFallbackColor`

### `Toast`

- **Sub-components:** `.Background`, `.Title`, `.Description`, `.Action`, `.Close`
- `ToastBackgroundProps`: `className`
- `ToastRootProps`: `className`, `background`, `isAnimatedStyleActive`
- `ToastTitleProps`: `children`, `className`
- `ToastDescriptionProps`: `children`, `className`
- `ToastCloseProps`: `iconProps`, `size`, `color`
- `DefaultToastProps`: `variant`, `placement`, `animation`, `isSwipeable`, `label`, `description`, `actionLabel`, `onActionPress`, `show`, `hide`, `icon`

## heroui-native-pro 1.0.0-beta.10

### `Agenda`

- **Sub-components:** `.Background`, `.Header`, `.Calendar`, `.CalendarHeader`, `.CalendarGrid`, `.Heading`, `.NavButton`, `.DragArea`, `.DragHandle`, `.Body`, `.WeekHeader`, `.AllDaySection`, `.TimeGrid`, `.DayColumns`, `.Event`, `.EventTitle`, `.EventTime`, `.CurrentTimeIndicator`, `.MonthGrid`, `.ViewSelector`
- `AgendaSplitViewPassthroughProps`: `defaultSnapIndex`
- `AgendaRootProps`: `children`, `className`, `animation`, `background`
- `AgendaBackgroundProps`: `className`
- `AgendaHeaderProps`: `className`
- `AgendaCalendarProps`: `children`, `className`
- `AgendaCalendarHeaderProps`: `children`, `className`
- `AgendaCalendarGridProps`: `children`, `className`
- `AgendaHeadingProps`: `children`, `className`
- `AgendaTodayButtonProps`: `children`, `className`
- `AgendaNavButtonProps`: `slot`, `children`, `className`
- `AgendaBodyProps`: `children`, `className`, `showBottomFade`, `bottomFadeColor`, `bottomFadeHeight`
- `AgendaWeekHeaderProps`: `showDates`, `className`, `classNames`, `styles`
- `AgendaAllDaySectionProps`: `children`, `className`, `classNames`, `styles`
- `AgendaTimeGridProps`: `children`, `className`, `classNames`, `styles`, `showTopFade`, `topFadeColor`, `topFadeHeight`
- `AgendaDayColumnsProps`: `children`, `className`, `classNames`, `styles`
- `AgendaEventProps`: `event`, `children`, `className`, `classNames`, `styles`, `animation`, `isAnimatedStyleActive`
- `AgendaEventTitleProps`: `children`, `className`
- `AgendaEventTimeProps`: `children`, `className`
- `AgendaCurrentTimeIndicatorProps`: `className`, `classNames`, `styles`
- `AgendaMonthGridProps`: `children`, `maxEventsPerCell`, `moreLabel`, `className`, `classNames`, `styles`
- `AgendaViewSelectorProps`: `children`, `options`, `labels`, `size`, `className`

### `AreaChart` ✅

- `AreaChartRootProps`: `wrapperClassName`, `animation`

### `Autocomplete`

- **Sub-components:** `.Trigger`, `.Value`, `.TriggerIndicator`, `.ClearButton`, `.Overlay`, `.Content`, `.ContentBackground`, `.SearchField`, `.List`, `.Item`, `.ItemLabel`, `.ItemDescription`, `.ItemIndicator`, `.ListLabel`, `.Empty`, `.Close`
- `AutocompleteRootProps`: `isInvalid`, `isRequired`, `inputValue`, `defaultInputValue`, `onInputChange`, `filter`, `clearInputOnClose`, `onClear`, `animation`
- `AutocompleteTriggerProps`: `isInvalid`
- `AutocompleteValueProps`: `placeholder`
- `AutocompleteSearchFieldProps`: `placeholder`, `autoFocus`, `autoFocusDelay`, `inputProps`
- `AutocompleteListProps`: `className`
- `AutocompleteItemProps`: `textValue`
- `AutocompleteEmptyProps`: `className`, `classNames`, `styles`

### `Badge`

- **Sub-components:** `.Anchor`, `.Background`, `.Label`
- `BadgeAnchorProps`: `children`, `className`
- `BadgeRootProps`: `children`, `color`, `variant`, `size`, `placement`, `className`, `animation`, `background`
- `BadgeBackgroundProps`: `children`, `className`
- `BadgeLabelProps`: `children`, `className`

### `BarChart`

- `BarChartRootProps`: `wrapperClassName`, `animation`

### `Calendar`

- **Sub-components:** `.Header`, `.Heading`, `.NavButton`, `.Grid`, `.GridHeader`, `.GridBody`, `.HeaderCell`, `.HeaderCellLabel`, `.Cell`, `.CellBody`, `.CellLabel`, `.CellIndicator`, `.YearPickerTrigger`, `.YearPickerTriggerHeading`, `.YearPickerTriggerIndicator`, `.YearPickerGrid`, `.YearPickerGridBody`, `.YearPickerCell`
- `CalendarProps`: `className`, `animation`, `isYearPickerOpen`, `defaultYearPickerOpen`, `onYearPickerOpenChange`
- `CalendarHeaderComponentProps`: `className`
- `CalendarHeadingComponentProps`: `className`
- `CalendarNavButtonIconProps`: `size`, `color`
- `CalendarNavButtonComponentProps`: `className`, `iconProps`
- `CalendarGridComponentProps`: `className`
- `CalendarGridHeaderComponentProps`: `className`
- `CalendarGridBodyComponentProps`: `className`
- `CalendarHeaderCellComponentProps`: `day`, `className`
- `CalendarCellComponentProps`: `className`
- `CalendarCellIndicatorComponentProps`: `cellRenderProps`, `className`
- `CalendarCellBodyProps`: `cellRenderProps`, `animation`, `isAnimatedStyleActive`, `children`, `className`
- `CalendarCellLabelProps`: `cellRenderProps`, `children`, `className`
- `CalendarHeaderCellLabelProps`: `children`, `className`

### `CalendarYearPicker`

- **Sub-components:** `.Trigger`, `.TriggerHeading`, `.TriggerIndicator`, `.Grid`, `.GridBackground`, `.GridBody`, `.Cell`
- `YearPickerTriggerRenderProps`: `isOpen`, `monthYear`, `toggle`
- `YearPickerTriggerProps`: `children`
- `YearPickerTriggerHeadingProps`: `children`
- `YearPickerTriggerIndicatorProps`: `children`, `iconProps`, `animation`, `isAnimatedStyleActive`
- `YearPickerCellRenderProps`: `year`, `formattedYear`, `isSelected`, `isCurrentYear`, `isOpen`, `selectYear`
- `YearPickerGridProps`: `animation`, `background`, `isAnimatedStyleActive`
- `YearPickerGridBackgroundProps`: `className`
- `YearPickerGridBodyProps`: `children`, `cellHeight`
- `YearPickerCellProps`: `year`, `isSelected`, `children`

### `Carousel`

- **Sub-components:** `.Content`, `.Item`, `.Previous`, `.Next`, `.NavButtonBackground`, `.Dots`, `.Thumbnails`, `.Thumbnail`
- `CarouselRootProps`: `children`, `itemsPerView`, `gap`, `sidePadding`, `align`, `type`, `defaultIndex`, `autoPlay`, `autoPlayInterval`, `stopAutoPlayOnInteraction`, `className`, `onSelectedIndexChange`, `animation`
- `CarouselContentProps`: `children`, `className`, `classNames`, `styles`
- `CarouselItemProps`: `children`, `className`
- `CarouselNavButtonProps`: `children`, `className`, `classNames`, `styles`, `style`, `background`
- `CarouselNavButtonBackgroundProps`: `children`, `className`
- `CarouselDotRenderProps`: `index`, `isSelected`, `progress`
- `CarouselDotsProps`: `className`, `classNames`, `styles`, `renderDot`, `animation`, `isAnimatedStyleActive`
- `CarouselThumbnailsProps`: `children`, `className`, `classNames`, `styles`
- `CarouselThumbnailProps`: `children`, `index`, `source`, `className`, `classNames`, `styles`, `style`, `imageProps`, `animation`, `isAnimatedStyleActive`

### `ChartCrosshair`

- **Sub-components:** `.Anchor`, `.Value`, `.ValueBackground`, `.ValueLabel`
- `ChartCrosshairProps`: `x`, `top`, `bottom`, `variant`
- `ChartCrosshairAnchorProps`: `children`, `chartBounds`, `isActive`, `x`
- `ChartCrosshairValueProps`: `value`, `variant`, `placement`, `className`, `classNames`, `styles`, `offset`, `children`, `background`
- `ChartCrosshairValueBackgroundProps`: `children`, `className`
- `ChartCrosshairValueLabelProps`: `className`, `style`

### `ChartIndicator`

- `ChartIndicatorProps`: `x`, `y`, `innerRadius`, `outerRadius`, `outerColor`, `innerColor`

### `ChartTooltip`

- **Sub-components:** `.Anchor`, `.Background`, `.Header`, `.Indicator`, `.Item`, `.Label`, `.Value`
- `ChartTooltipAnchorProps`: `children`, `animation`, `chartBounds`, `isActive`, `matchedIndex`, `x`, `y`
- `ChartTooltipRootProps`: `children`, `animation`, `isVisible`, `gap`, `placement`, `offset`, `background`, `className`
- `ChartTooltipBackgroundProps`: `className`
- `ChartTooltipHeaderProps`: `children`, `className`
- `ChartTooltipItemProps`: `children`, `className`
- `ChartTooltipIndicatorProps`: `color`, `variant`, `className`
- `ChartTooltipLabelProps`: `children`, `className`
- `ChartTooltipValueProps`: `children`, `className`

### `ComboBox`

- `ComboBoxRootProps`: `isInvalid`, `isRequired`, `inputValue`, `defaultInputValue`, `onInputChange`, `menuTrigger`, `filter`, `onClear`, `animation`
- `ComboBoxInputProps`: `onChangeText`
- `ComboBoxValueProps`: `placeholder`
- `ComboBoxContentProps`: `presentation`
- `ComboBoxListProps`: `className`
- `ComboBoxItemProps`: `textValue`
- `ComboBoxEmptyProps`: `className`, `classNames`, `styles`

### `ComposedChart`

- `ComposedChartRootProps`: `wrapperClassName`, `animation`

### `DateField`

- `DateFieldRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`, `value`, `defaultValue`, `onValueChange`, `isOpen`, `isDefaultOpen`, `onOpenChange`, `locale`, `inputMode`
- `DateFieldCalendarProps`: `accessibilityLabel`
- `DateFieldInputProps`: `onChangeText`

### `DatePicker`

- **Sub-components:** `.Select`, `.Overlay`, `.Content`, `.Calendar`, `.Trigger`, `.Value`, `.TriggerIndicator`
- `DatePickerRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`, `value`, `defaultValue`, `onValueChange`, `isOpen`, `isDefaultOpen`, `onOpenChange`, `dateDisplayFormat`, `locale`, `formatDate`
- `DatePickerCalendarProps`: `accessibilityLabel`
- `DatePickerTriggerProps`: `isInvalid`
- `DatePickerValueProps`: `placeholder`

### `DateRangePicker`

- **Sub-components:** `.Select`, `.Overlay`, `.Content`, `.Calendar`, `.Trigger`, `.Value`, `.TriggerIndicator`
- `DateRangePickerRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`, `value`, `defaultValue`, `onValueChange`, `isOpen`, `isDefaultOpen`, `onOpenChange`, `dateDisplayFormat`, `locale`, `formatDateRange`, `rangeSeparator`
- `DateRangePickerCalendarProps`: `accessibilityLabel`, `onChange`
- `DateRangePickerTriggerProps`: `isInvalid`
- `DateRangePickerValueProps`: `placeholder`

### `DateTimePicker`

- **Sub-components:** `.Select`, `.Overlay`, `.Content`, `.Trigger`, `.Value`, `.TriggerIndicator`, `.Wheel`, `.WheelDate`, `.WheelHour`, `.WheelMinute`, `.WheelPeriod`, `.WheelIndicator`, `.WheelMask`
- `DateTimePickerRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`, `value`, `defaultValue`, `onValueChange`, `isOpen`, `isDefaultOpen`, `onOpenChange`, `minValue`, `maxValue`, `hourFormat`, `minuteInterval`, `dateTimeDisplayFormat`, `locale`, `formatDate`, `formatDateTime`
- `DateTimePickerTriggerProps`: `isInvalid`
- `DateTimePickerValueProps`: `placeholder`

### `EmptyState` ✅

- **Sub-components:** `.Header`, `.Media`, `.MediaBackground`, `.Title`, `.Description`, `.Content`
- `EmptyStateRootProps`: `children`, `className`, `animation`
- `EmptyStateHeaderProps`: `children`, `className`
- `EmptyStateMediaProps`: `children`, `variant`, `className`, `background`
- `EmptyStateMediaBackgroundProps`: `children`, `className`
- `EmptyStateTitleProps`: `children`, `className`
- `EmptyStateDescriptionProps`: `children`, `className`
- `EmptyStateContentProps`: `children`, `className`

### `Fab`

- **Sub-components:** `.Trigger`, `.Overlay`, `.Content`, `.Item`, `.ItemBackground`, `.ItemLabel`
- `FABRootProps`: `children`, `itemsAppearance`, `className`, `animation`
- `FABTriggerProps`: `children`, `className`, `classNames`, `styles`, `animation`, `isAnimatedStyleActive`
- `FABPortalProps`: `disableFullWindowOverlay`, `unstable_accessibilityContainerViewIsModal`, `className`
- `FABOverlayProps`: `className`, `animation`, `isAnimatedStyleActive`, `variant`, `blurViewProps`
- `FABContentProps`: `children`, `className`
- `FABItemProps`: `children`, `className`, `background`, `animation`, `isAnimatedStyleActive`
- `FABItemBackgroundProps`: `className`
- `FABItemLabelProps`: `children`, `className`

### `FlipCard`

- **Sub-components:** `.Front`, `.Back`, `.FaceBackground`
- `FlipCardFaceBackgroundProps`: `className`
- `FlipCardRootProps`: `children`, `direction`, `rotation`, `isFlipped`, `defaultFlipped`, `isPressDisabled`, `className`, `onFlipChange`, `animation`
- `FlipCardFrontProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`, `background`
- `FlipCardBackProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`, `background`

### `LineChart`

- `LineChartRootProps`: `wrapperClassName`, `animation`
- `LineChartAnimatedLineProps`: `points`, `curveType`, `connectMissingData`, `animation`, `resetKey`

### `MorphButton`

- **Sub-components:** `.CollapsedContent`, `.ExpandedContent`
- `MorphButtonRootProps`: `children`, `direction`, `variant`, `isOpen`, `defaultOpen`, `isDisabled`, `className`, `classNames`, `styles`, `style`, `onOpenChange`, `animation`
- `MorphButtonCollapsedContentProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`
- `MorphButtonExpandedContentProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`

### `NumberField`

- **Sub-components:** `.Group`, `.Input`, `.DecrementButton`, `.IncrementButton`
- `NumberFieldProps`: `children`, `className`, `value`, `defaultValue`, `onChange`, `minValue`, `maxValue`, `step`, `formatOptions`, `isDisabled`, `isInvalid`, `isRequired`, `animation`
- `NumberFieldGroupProps`: `children`, `className`
- `NumberFieldInputProps`: `isAutoPaddingActive`, `autoPaddingAddon`
- `NumberFieldButtonProps`: `children`, `style`, `className`, `classNames`, `styles`, `animation`, `isAnimatedStyleActive`, `iconProps`

### `NumberPad` ✅

- **Sub-components:** `.Row`, `.Key`, `.KeyBackground`, `.KeyLabel`, `.Backspace`, `.Spacer`
- `NumberPadRootProps`: `children`, `value`, `defaultValue`, `onValueChange`, `maxLength`, `onKeyPress`, `onBackspacePress`, `onSpacerPress`, `onClear`, `onComplete`, `isDisabled`, `className`, `animation`, `highlightColor`
- `NumberPadRowProps`: `children`, `className`
- `NumberPadBackspaceIconProps`: `size`, `color`
- `NumberPadKeyRenderProps`: `value`, `isPressed`, `isDisabled`
- `NumberPadKeyProps`: `value`, `isDisabled`, `children`, `className`, `animation`, `isAnimatedStyleActive`, `highlightColor`, `background`
- `NumberPadKeyBackgroundProps`: `className`
- `NumberPadKeyLabelProps`: `children`, `className`
- `NumberPadBackspaceProps`: `children`, `iconProps`
- `NumberPadSpacerProps`: `children`

### `NumberStepper`

- **Sub-components:** `.RootBackground`, `.DecrementButton`, `.ButtonBackground`, `.Value`, `.IncrementButton`
- `NumberStepperRootProps`: `className`, `animation`, `background`
- `NumberStepperRootBackgroundProps`: `className`
- `NumberStepperValueProps`: `children`, `className`, `animation`
- `NumberStepperButtonIconProps`: `size`, `color`
- `NumberStepperButtonBackgroundProps`: `className`
- `NumberStepperDecrementButtonProps`: `children`, `className`, `background`, `iconProps`, `animation`, `isAnimatedStyleActive`
- `NumberStepperIncrementButtonProps`: `children`, `className`, `background`, `iconProps`, `animation`, `isAnimatedStyleActive`

### `NumberValue` ✅

- **Sub-components:** `.Value`, `.Prefix`, `.Suffix`
- `NumberValueRootProps`: `value`, `children`, `formatOptions`, `locale`, `numberStyle`, `currency`, `unit`, `notation`, `signDisplay`, `minimumFractionDigits`, `maximumFractionDigits`, `className`, `classNames`, `styles`, `animation`
- `NumberValueValueProps`: `className`
- `NumberValuePrefixProps`: `className`
- `NumberValueSuffixProps`: `className`

### `PhoneNumberField`

- `PhoneNumberFieldRootProps`: `children`, `value`, `defaultValue`, `country`, `defaultCountry`, `isOpen`, `isDefaultOpen`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `countries`, `onValueChange`, `onCountryChange`, `onOpenChange`, `animation`
- `PhoneNumberFieldContentProps`: `presentation`
- `PhoneNumberFieldContentHandleProps`: `className`
- `PhoneNumberFieldTriggerProps`: `classNames`, `styles`
- `PhoneNumberFieldSearchInputProps`: `onChange`, `autoFocus`, `inputProps`
- `PhoneNumberFieldCountryListProps`: `countries`, `renderCountry`, `emptyText`, `className`, `classNames`, `styles`
- `PhoneNumberFieldCountryItemProps`: `country`, `children`, `classNames`, `styles`
- `PhoneNumberFieldInputProps`: `onChangeText`

### `PieChart`

- `PieChartRootProps`: `children`, `wrapperClassName`, `animation`
- `PieChartPieProps`: `children`

### `ProgressBar` ✅

- **Sub-components:** `.Track`, `.TrackBackground`, `.Fill`, `.Label`, `.ValueLabel`
- `ProgressBarRenderProps`: `percentage`, `valueText`, `isIndeterminate`
- `ProgressBarRootProps`: `children`, `value`, `minValue`, `maxValue`, `isIndeterminate`, `isDisabled`, `size`, `color`, `formatOptions`, `className`, `animation`
- `ProgressBarTrackProps`: `children`, `className`, `background`
- `ProgressBarTrackBackgroundProps`: `children`, `className`
- `ProgressBarFillProps`: `className`, `animation`, `isAnimatedStyleActive`
- `ProgressBarLabelProps`: `children`, `className`
- `ProgressBarValueLabelProps`: `children`, `className`

### `ProgressButton` ✅

- **Sub-components:** `.Background`, `.Label`, `.Overlay`, `.MaskLabel`
- `ProgressButtonRootProps`: `children`, `variant`, `holdDuration`, `isCompleted`, `isDefaultCompleted`, `isDisabled`, `autoReset`, `autoResetDelay`, `className`, `onCompleteChange`, `onComplete`, `onReset`, `animation`, `background`
- `ProgressButtonBackgroundProps`: `children`, `className`
- `ProgressButtonOverlayProps`: `children`, `className`
- `ProgressButtonLabelProps`: `children`, `className`
- `ProgressButtonMaskLabelProps`: `children`, `className`

### `ProgressCircle` ✅

- **Sub-components:** `.Indicator`, `.ValueLabel`
- `ProgressCircleRenderProps`: `percentage`, `valueText`, `isIndeterminate`
- `ProgressCircleRootProps`: `children`, `value`, `minValue`, `maxValue`, `isIndeterminate`, `isDisabled`, `size`, `color`, `formatOptions`, `className`, `animation`
- `ProgressCircleIndicatorProps`: `strokeWidth`, `trackColor`, `fillColor`, `className`, `animation`
- `ProgressCircleValueLabelProps`: `children`, `className`

### `RadarChart`

- `RadarChartRootProps`: `children`, `data`, `labelKey`, `dataKey`, `maxValue`, `wrapperClassName`, `animation`
- `RadarChartGridProps`: `numTicks`, `strokeColor`, `strokeWidth`, `shape`, `showSpokes`
- `RadarChartAngleAxisProps`: `font`, `color`, `radiusOffset`
- `RadarChartRadiusAxisProps`: `font`, `color`, `numTicks`, `dataKey`, `tickFormatter`, `angle`, `orientation`, `includeZero`
- `RadarChartRadarProps`: `dataKey`, `color`, `fillOpacity`, `showStroke`, `strokeWidth`, `showDots`, `dotRadius`, `animate`

### `RadialChart`

- `RadialChartRootProps`: `children`, `domain`, `startAngle`, `endAngle`, `innerRadius`, `outerRadius`, `barSize`, `barGap`, `wrapperClassName`, `animation`
- `RadialChartBarProps`: `background`, `barSize`, `cornerRadius`, `trackColor`, `animate`

### `RadioButtonGroup`

- **Sub-components:** `.Item`, `.ItemBackground`, `.ItemContent`
- `RadioButtonGroupItemProps`: `background`
- `RadioButtonGroupItemBackgroundProps`: `children`, `className`
- `RadioButtonGroupItemContentProps`: `className`

### `RangeCalendar`

- **Sub-components:** `.Header`, `.Heading`, `.NavButton`, `.Grid`, `.GridHeader`, `.GridBody`, `.HeaderCell`, `.HeaderCellLabel`, `.Cell`, `.CellBody`, `.CellLabel`, `.CellIndicator`, `.YearPickerTrigger`, `.YearPickerTriggerHeading`, `.YearPickerTriggerIndicator`, `.YearPickerGrid`, `.YearPickerGridBody`, `.YearPickerCell`
- `RangeCalendarProps`: `className`, `animation`, `isYearPickerOpen`, `defaultYearPickerOpen`, `onYearPickerOpenChange`
- `RangeCalendarHeaderComponentProps`: `className`
- `RangeCalendarHeadingComponentProps`: `className`
- `RangeCalendarNavButtonIconProps`: `size`, `color`
- `RangeCalendarNavButtonComponentProps`: `className`, `iconProps`
- `RangeCalendarGridComponentProps`: `className`
- `RangeCalendarGridHeaderComponentProps`: `className`
- `RangeCalendarGridBodyComponentProps`: `className`
- `RangeCalendarHeaderCellComponentProps`: `day`, `className`
- `RangeCalendarCellComponentProps`: `className`
- `RangeCalendarCellIndicatorComponentProps`: `cellRenderProps`, `className`
- `RangeCalendarCellBodyProps`: `cellRenderProps`, `animation`, `isAnimatedStyleActive`, `children`, `className`
- `RangeCalendarCellLabelProps`: `cellRenderProps`, `children`, `className`
- `RangeCalendarHeaderCellLabelProps`: `children`, `className`

### `Rating`

- **Sub-components:** `.Item`
- `RatingItemRenderProps`: `isActive`, `isPartial`, `partialPercent`
- `RatingIconProps`: `size`, `inactiveColor`, `activeColor`, `inactiveColorClassName`, `activeColorClassName`
- `RatingRootProps`: `children`, `value`, `defaultValue`, `onValueChange`, `maxValue`, `size`, `isReadOnly`, `icon`, `iconProps`, `className`
- `RatingItemProps`: `value`, `icon`, `children`, `animation`, `isAnimatedStyleActive`, `className`

### `Segment` ✅

- **Sub-components:** `.Group`, `.Indicator`, `.Item`, `.Label`, `.ScrollView`, `.Separator`
- `SegmentRootProps`: `value`, `defaultValue`, `onValueChange`, `isDisabled`, `size`

### `SlideButton` ✅

- **Sub-components:** `.UnderlayContent`, `.OverlayContent`, `.Thumb`, `.ThumbBackground`, `.ContainerBackground`, `.Label`
- `SlideButtonRootProps`: `children`, `variant`, `isCompleted`, `isDefaultCompleted`, `isDisabled`, `completionThreshold`, `autoReset`, `background`, `autoResetDelay`, `className`, `classNames`, `styles`, `onCompleteChange`, `onComplete`, `onReset`, `animation`
- `SlideButtonThumbProps`: `children`, `className`, `animation`, `isAnimatedStyleActive`, `iconProps`, `background`
- `SlideButtonThumbBackgroundProps`: `className`
- `SlideButtonContainerBackgroundProps`: `className`
- `SlideButtonThumbIconProps`: `size`, `color`
- `SlideButtonUnderlayContentProps`: `children`, `className`, `classNames`, `styles`
- `SlideButtonOverlayContentProps`: `children`, `className`, `classNames`, `styles`
- `SlideButtonLabelProps`: `children`, `className`

### `SocialAuthButton`

- `SocialAuthButtonIconProps`: `size`, `color`, `colorClassName`
- `SocialAuthButtonProps`: `provider`, `iconProps`, `label`

### `SplitView`

- **Sub-components:** `.TopSection`, `.DragArea`, `.DragHandle`, `.BottomSection`
- `SplitViewRootProps`: `animation`, `className`
- `SplitViewTopSectionProps`: `className`
- `SplitViewBottomSectionProps`: `className`
- `SplitViewDragAreaProps`: `className`
- `SplitViewDragHandleProps`: `className`, `animation`, `isAnimatedStyleActive`

### `Stepper`

- **Sub-components:** `.Step`, `.Rail`, `.Indicator`, `.IndicatorCheck`, `.IndicatorNumber`, `.Separator`, `.SeparatorTrack`, `.SeparatorFill`, `.Content`, `.Title`, `.Description`
- `StepperProps`: `className`, `animation`
- `StepperStepProps`: `className`
- `StepperRailProps`: `className`
- `StepperIndicatorProps`: `className`
- `StepperIndicatorCheckProps`: `className`, `size`, `strokeWidth`, `color`, `enterDuration`, `exitDuration`
- `StepperIndicatorNumberProps`: `className`, `children`
- `StepperSeparatorProps`: `className`
- `StepperSeparatorTrackProps`: `className`
- `StepperSeparatorFillProps`: `className`, `animation`, `isAnimatedStyleActive`
- `StepperContentProps`: `className`
- `StepperTitleProps`: `className`
- `StepperDescriptionProps`: `className`

### `Table`

- **Sub-components:** `.Background`, `.ScrollContainer`, `.Content`, `.Header`, `.Column`, `.Row`, `.Cell`, `.SelectAllCell`, `.SelectionCell`, `.Footer`
- `TableRootProps`: `children`, `variant`, `className`, `animation`, `background`
- `TableBackgroundProps`: `className`
- `TableScrollContainerProps`: `children`, `className`, `contentContainerClassName`
- `TableContentProps`: `children`, `className`
- `TableHeaderProps`: `children`, `className`
- `TableColumnProps`: `children`, `className`, `classNames`, `styles`, `indicator`, `textProps`, `animation`, `isAnimatedStyleActive`
- `TableBodyProps`: `ref`, `children`, `items`, `keyExtractor`, `virtualized`, `renderEmptyState`, `className`, `classNames`, `styles`, `flatListProps`
- `TableRowProps`: `children`, `className`
- `TableCellProps`: `children`, `className`, `classNames`, `styles`, `textProps`
- `TableSelectAllCellProps`: `className`, `width`, `checkboxProps`
- `TableSelectionCellProps`: `className`, `checkboxProps`
- `TableFooterProps`: `children`, `className`

### `TimePicker`

- **Sub-components:** `.Select`, `.Overlay`, `.Content`, `.Trigger`, `.Value`, `.TriggerIndicator`, `.Wheel`, `.WheelHour`, `.WheelMinute`, `.WheelPeriod`, `.WheelIndicator`, `.WheelMask`
- `TimePickerRootProps`: `children`, `isDisabled`, `isInvalid`, `isRequired`, `className`, `animation`, `value`, `defaultValue`, `onValueChange`, `isOpen`, `isDefaultOpen`, `onOpenChange`, `hourFormat`, `minuteInterval`, `timeDisplayFormat`, `locale`, `formatTime`
- `TimePickerTriggerProps`: `isInvalid`
- `TimePickerValueProps`: `placeholder`

### `Timeline`

- **Sub-components:** `.Item`, `.Leading`, `.Rail`, `.Marker`, `.Connector`, `.Content`, `.Title`, `.Description`
- `TimelineProps`: `size`, `density`, `itemAlign`, `className`, `animation`
- `TimelineItemProps`: `className`
- `TimelineLeadingProps`: `className`
- `TimelineRailProps`: `className`
- `TimelineMarkerProps`: `className`
- `TimelineConnectorProps`: `className`
- `TimelineContentProps`: `className`
- `TimelineTitleProps`: `className`
- `TimelineDescriptionProps`: `className`

### `ToggleButton`

- **Sub-components:** `.Label`
- `ToggleButtonProps`: `id`, `variant`, `isSelected`, `defaultSelected`, `onChange`, `selectedColor`, `unselectedColor`, `background`

### `ToggleButtonGroup`

- `ToggleButtonGroupRootProps`: `children`, `selectionMode`, `selectedKeys`, `defaultSelectedKeys`, `onSelectionChange`, `disallowEmptySelection`, `orientation`, `size`, `isDetached`, `fullWidth`, `isDisabled`, `className`

### `TrendChip` ✅

- **Sub-components:** `.Indicator`, `.Value`, `.Prefix`, `.Suffix`
- `TrendArrowIconProps`: `size`, `color`, `colorClassName`
- `TrendChipRootProps`: `children`, `size`, `trend`, `variant`, `className`
- `TrendChipIndicatorProps`: `children`, `className`
- `TrendChipValueProps`: `(all of ChipLabelProps)`
- `TrendChipPrefixProps`: `(all of ChipLabelProps)`
- `TrendChipSuffixProps`: `(all of ChipLabelProps)`

### `WheelDateTimePicker`

- **Sub-components:** `.Date`, `.Hour`, `.Minute`, `.Period`, `.Indicator`, `.Mask`
- `WheelDateTimePickerRootProps`: `value`, `defaultValue`, `onValueChange`, `onValueCommit`, `minValue`, `maxValue`, `hourFormat`, `minuteInterval`, `locale`, `formatDate`
- `WheelDateTimePickerDateProps`: `(all of Omit<WheelPickerRootProps<string>, 'name' | 'items'>)`
- `WheelDateTimePickerHourProps`: `(all of Omit<WheelPickerRootProps<number>, 'name' | 'items'>)`
- `WheelDateTimePickerMinuteProps`: `(all of Omit<WheelPickerRootProps<number>, 'name' | 'items'>)`
- `WheelDateTimePickerPeriodProps`: `(all of Omit<WheelPickerRootProps<WheelDateTimePickerPeriod>, 'name' | 'items'>)`
- `WheelDateTimePickerIndicatorProps`: `(all of WheelPickerGroupIndicatorProps)`
- `WheelDateTimePickerMaskProps`: `(all of WheelPickerGroupMaskProps)`

### `WheelPicker`

- **Sub-components:** `.Item`, `.ItemLabel`, `.Indicator`, `.IndicatorBackground`, `.Mask`
- `WheelPickerRootProps`: `children`, `items`, `itemHeight`, `visibleCount`, `value`, `defaultValue`, `name`, `isDisabled`, `className`, `classNames`, `styles`, `renderItem`, `keyExtractor`, `onValueChange`, `animation`
- `WheelPickerIndicatorProps`: `children`, `className`, `classNames`, `styles`, `background`
- `WheelPickerIndicatorBackgroundProps`: `children`, `className`
- `WheelPickerMaskProps`: `color`, `height`, `className`, `classNames`, `styles`
- `WheelPickerItemProps`: `children`, `className`, `style`
- `WheelPickerItemRenderProps`: `item`, `index`, `isSelected`, `absDistance`
- `WheelPickerItemLabelProps`: `className`

### `WheelPickerGroup`

- **Sub-components:** `.Indicator`, `.IndicatorBackground`, `.Mask`
- `WheelPickerGroupRootProps`: `children`, `values`, `defaultValues`, `itemHeight`, `visibleCount`, `isDisabled`, `className`, `onValuesChange`, `onValuesCommit`, `animation`
- `WheelPickerGroupIndicatorProps`: `children`, `className`, `classNames`, `styles`, `background`
- `WheelPickerGroupIndicatorBackgroundProps`: `children`, `className`
- `WheelPickerGroupMaskProps`: `color`, `height`, `className`, `classNames`, `styles`

### `WheelTimePicker`

- **Sub-components:** `.Hour`, `.Minute`, `.Period`, `.Indicator`, `.Mask`
- `WheelTimePickerRootProps`: `value`, `defaultValue`, `onValueChange`, `onValueCommit`, `hourFormat`, `minuteInterval`, `locale`
- `WheelTimePickerHourProps`: `(all of Omit<WheelPickerRootProps<number>, 'name' | 'items'>)`
- `WheelTimePickerMinuteProps`: `(all of Omit<WheelPickerRootProps<number>, 'name' | 'items'>)`
- `WheelTimePickerPeriodProps`: `(all of Omit<WheelPickerRootProps<WheelTimePickerPeriod>, 'name' | 'items'>)`
- `WheelTimePickerIndicatorProps`: `(all of WheelPickerGroupIndicatorProps)`
- `WheelTimePickerMaskProps`: `(all of WheelPickerGroupMaskProps)`

### `Widget`

- **Sub-components:** `.Background`, `.Header`, `.Title`, `.Description`, `.Content`, `.Footer`, `.Legend`, `.LegendItem`
- `WidgetBackgroundProps`: `className`
- `WidgetRootProps`: `children`, `className`, `animation`, `background`
- `WidgetHeaderProps`: `children`, `className`
- `WidgetTitleProps`: `children`, `className`
- `WidgetDescriptionProps`: `children`, `className`
- `WidgetContentProps`: `children`, `className`
- `WidgetFooterProps`: `children`, `className`
- `WidgetLegendProps`: `children`, `className`
- `WidgetLegendItemProps`: `children`, `color`, `colorClassName`, `className`, `classNames`, `styles`, `textProps`
