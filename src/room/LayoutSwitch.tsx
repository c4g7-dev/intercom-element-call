/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type ChangeEvent,
  type ComponentType,
  type FC,
  type SVGAttributes,
  useCallback,
  useId,
} from "react";
import {
  SpotlightViewIcon,
  GridIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@vector-im/compound-web";
import classNames from "classnames";

import {
  type LayoutMode,
  type LayoutSwitchViewModel,
} from "../state/LayoutSwitchViewModel";
import { useBehavior } from "../useBehavior";
import styles from "./LayoutSwitch.module.css";

interface Props {
  vm: LayoutSwitchViewModel;
  className?: string;
}

/** Six tiles of one size, which is what the equal grid is. */
const EqualGridIcon: FC<SVGAttributes<SVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="currentColor"
    {...props}
  >
    <rect x="2" y="6" width="6" height="5" rx="1" />
    <rect x="9" y="6" width="6" height="5" rx="1" />
    <rect x="16" y="6" width="6" height="5" rx="1" />
    <rect x="2" y="13" width="6" height="5" rx="1" />
    <rect x="9" y="13" width="6" height="5" rx="1" />
    <rect x="16" y="13" width="6" height="5" rx="1" />
  </svg>
);

/**
 * The switch between the call's layouts: one radio button per layout, drawn
 * as its icon.
 */
export const LayoutSwitch: FC<Props> = ({ vm, className }) => {
  const { t } = useTranslation();
  const layout = useBehavior(vm.layout$);
  const name = useId();
  const { setLayout } = vm;
  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) =>
      setLayout(e.target.value as LayoutMode),
    [setLayout],
  );

  const options: [
    LayoutMode,
    string,
    ComponentType<SVGAttributes<SVGElement>>,
  ][] = [
    ["spotlight", t("layout_spotlight_label"), SpotlightViewIcon],
    ["grid", t("layout_grid_label"), GridIcon],
    ["equal-grid", t("layout_equal_grid_label"), EqualGridIcon],
  ];

  return (
    <fieldset
      className={classNames(styles.switch, className)}
      aria-label={t("layout_switch_label")}
      data-testid="layout_switch"
    >
      {options.map(([value, label, Icon]) => (
        <span key={value} className={styles.option}>
          <Tooltip label={label}>
            <input
              type="radio"
              name={name}
              value={value}
              aria-label={label}
              checked={layout === value}
              onChange={onChange}
            />
          </Tooltip>
          <Icon aria-hidden />
        </span>
      ))}
    </fieldset>
  );
};
