import { forwardRef, useId, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import MuiButton, {
  type ButtonProps as MuiButtonProps,
} from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import MuiIconButton, {
  type IconButtonProps as MuiIconButtonProps,
} from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import Select, { type SelectProps } from "@mui/material/Select";
import TextField, { type TextFieldProps } from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";

export {
  Alert as AppAlert,
  ToggleButton as ModeButton,
  ToggleButtonGroup as ModeButtonGroup,
};

export const AppButton = forwardRef<HTMLButtonElement, MuiButtonProps>(
  function AppButton({ variant = "outlined", ...props }, ref) {
    return <MuiButton ref={ref} variant={variant} {...props} />;
  },
);

export function AppIconButton({
  label,
  tooltip,
  ...props
}: Omit<MuiIconButtonProps, "aria-label"> & {
  label: string;
  tooltip?: string;
}) {
  const button = <MuiIconButton aria-label={label} {...props} />;
  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button;
}

export function TextInput(props: TextFieldProps) {
  return <TextField fullWidth size="small" variant="outlined" {...props} />;
}

export function SelectField({
  label,
  children,
  id: providedId,
  ...props
}: Omit<SelectProps<string>, "native" | "size"> & {
  label: string;
  children: ReactNode;
  id?: string;
}) {
  const generatedId = useId();
  const id = providedId || generatedId;
  const labelId = `${id}-label`;
  return (
    <FormControl fullWidth size="small">
      <InputLabel id={labelId} htmlFor={id}>
        {label}
      </InputLabel>
      <Select
        {...props}
        native
        id={id}
        labelId={labelId}
        label={label}
        inputProps={{ ...props.inputProps, id }}
      >
        {children}
      </Select>
    </FormControl>
  );
}
