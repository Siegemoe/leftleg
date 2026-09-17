<script lang="ts">
  // Renders a project icon choice: the Lucide component when the stored value
  // is a known icon name (or legacy emoji with a mapped glyph), the raw
  // string verbatim for any other legacy pick, and a neutral folder glyph
  // when nothing is set.
  import { projectIconComponent } from "../lib/project-icons";
  import { Folder } from "@lucide/svelte";

  let { icon, size = 14, strokeWidth = 2 }: { icon?: string; size?: number; strokeWidth?: number } = $props();

  let Comp = $derived(projectIconComponent(icon) ?? (icon ? null : Folder));
</script>

<span class="picon">
  {#if Comp}
    <Comp size={size} strokeWidth={strokeWidth} />
  {:else if icon}
    <span class="raw">{icon}</span>
  {/if}
</span>

<style>
  .picon {
    display: inline-flex;
    vertical-align: middle;
    line-height: 1;
    flex-shrink: 0;
  }
  .raw {
    font-size: inherit;
  }
</style>
