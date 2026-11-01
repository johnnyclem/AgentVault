import React from 'react';
import type {Props} from '@theme/Icon/Edit';
import {PencilIcon} from '@site/src/components/Icons';

/** Swizzled so the theme draws this icon from the site's one icon set. */
export default function IconEdit(props: Props): React.ReactNode {
  return <PencilIcon {...props} />;
}
