export interface PackageLayoutConfig {
  title: string;
  statusLabel: string;
  showSkillHint: boolean;
}

export const defaultPackageLayoutConfig: PackageLayoutConfig = {
  title: "Pi package layout",
  statusLabel: "layout",
  showSkillHint: true,
};
