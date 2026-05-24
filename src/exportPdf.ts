import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

export async function exportToPdf(contentEl: HTMLElement, name: string) {
  const node = contentEl.parentElement!; // .ink-wrapper
  const snapshot = await html2canvas(node, { backgroundColor: '#ffffff', scale: 2, useCORS: true });
  const pdf = new jsPDF({
    unit: 'px',
    format: [snapshot.width, snapshot.height],
    orientation: snapshot.width > snapshot.height ? 'landscape' : 'portrait',
  });
  pdf.addImage(snapshot.toDataURL('image/png'), 'PNG', 0, 0, snapshot.width, snapshot.height);
  pdf.save(`${name.replace(/\.md$/, '').replace(/[\/\\]/g, '_')}-annotated.pdf`);
}
