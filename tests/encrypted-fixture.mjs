import PDFDocument from 'pdfkit'

export function encryptedPdf(pdfVersion = '1.7ext3') {
  return new Promise((resolve, reject) => {
    const chunks = []
    const drawing = new PDFDocument({ size: [640, 800], pdfVersion, userPassword: '1234', ownerPassword: '5678' })
    drawing.on('data', chunk => chunks.push(chunk))
    drawing.on('error', reject)
    drawing.on('end', () => resolve(Buffer.concat(chunks)))
    drawing.font('Helvetica').fontSize(16).text('R3501 GND', 100, 200)
    drawing.addPage().fontSize(16).text('GND', 100, 300)
    drawing.end()
  })
}