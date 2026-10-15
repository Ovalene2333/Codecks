import {
  Children,
  Fragment,
  isValidElement,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
  title?: string;
}

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textOf(child.props.children)
        : String(child),
    )
    .join("");
}

/** Accept option/optgroup markup so choices remain colocated with their business logic. */
function optionsOf(
  children: ReactNode,
  group?: string,
  disabled = false,
): Option[] {
  return Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        label?: string;
        disabled?: boolean;
        title?: string;
      }>(child)
    )
      return [];
    if (child.type === Fragment)
      return optionsOf(child.props.children, group, disabled);
    if (child.type === "optgroup")
      return optionsOf(
        child.props.children,
        child.props.label,
        disabled || child.props.disabled,
      );
    if (child.type !== "option") return [];
    const label = child.props.label ?? textOf(child.props.children);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        group,
        disabled: disabled || child.props.disabled,
        title: child.props.title,
      },
    ];
  });
}

type SelectProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "defaultValue" | "onChange"
> & {
  value?: string | number;
  onValueChange: (value: string) => void;
  name?: string;
  required?: boolean;
};

/** Single-value selection; searchable catalogs use SearchablePicker instead. */
export function Select({
  value,
  onValueChange,
  children,
  disabled,
  name,
  required,
  className,
  ...triggerProps
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => optionsOf(children), [children]);
  const segments = options.reduce<{ group?: string; items: Option[] }[]>(
    (result, option) => {
      const last = result[result.length - 1];
      if (last && last.group === option.group) last.items.push(option);
      else result.push({ group: option.group, items: [option] });
      return result;
    },
    [],
  );
  const renderOption = (option: Option) => (
    <BaseSelect.Item
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      label={option.label}
      title={option.title}
      className="ui-select-option"
    >
      <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="ui-select-check">
        <Check />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
  const resolvedValue = String(value ?? options[0]?.value ?? "");
  const selected = options.find((option) => option.value === resolvedValue);
  return (
    <BaseSelect.Root
      open={open}
      onOpenChange={setOpen}
      value={resolvedValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
      name={name}
      required={required}
      items={options}
    >
      <BaseSelect.Trigger
        {...triggerProps}
        onKeyDown={(event) => {
          triggerProps.onKeyDown?.(event);
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={["ui-select-trigger", className].filter(Boolean).join(" ")}
      >
        <BaseSelect.Value className="ui-select-value">
          {selected?.label ?? resolvedValue}
        </BaseSelect.Value>
        <BaseSelect.Icon className="ui-select-icon">
          <ChevronDown />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="ui-select-positioner"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
          collisionPadding={8}
        >
          <BaseSelect.Popup
            className="ui-select-popup"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
              }
            }}
          >
            <BaseSelect.List className="ui-select-list">
              {segments.map((segment, index) =>
                segment.group ? (
                  <BaseSelect.Group key={index}>
                    <BaseSelect.GroupLabel className="ui-select-group">
                      {segment.group}
                    </BaseSelect.GroupLabel>
                    {segment.items.map(renderOption)}
                  </BaseSelect.Group>
                ) : (
                  <Fragment key={index}>
                    {segment.items.map(renderOption)}
                  </Fragment>
                ),
              )}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
