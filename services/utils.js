function formatRupiah(amount) {
  return 'Rp ' + amount.toLocaleString('id-ID', { 
    minimumFractionDigits: 0, 
    maximumFractionDigits: 0 
  });
}

function numberToWords(num) {
  const units = ['', 'Ribu', 'Juta', 'Miliar', 'Triliun'];
  const ones = ['', 'Satu', 'Dua', 'Tiga', 'Empat', 'Lima', 'Enam', 'Tujuh', 'Delapan', 'Sembilan'];
  const tens = ['', 'Sepuluh', 'Sebelas', 'Dua Belas', 'Tiga Belas', 'Empat Belas', 'Lima Belas', 'Enam Belas', 'Tujuh Belas', 'Delapan Belas', 'Sembilan Belas'];
  const twenties = ['', 'Dua Puluh', 'Tiga Puluh', 'Empat Puluh', 'Lima Puluh', 'Enam Puluh', 'Tujuh Puluh', 'Delapan Puluh', 'Sembilan Puluh'];

  if (num === 0) return 'Nol';
  
  let words = [];
  let i = 0;
  while (num > 0) {
    let chunk = num % 1000;
    if (chunk !== 0) {
      let chunkWords = [];
      let hundreds = Math.floor(chunk / 100);
      if (hundreds > 0) {
        chunkWords.push(ones[hundreds]);
        chunkWords.push('Ratus');
      }
      let tens = Math.floor((chunk % 100) / 10);
      let unitsDigit = chunk % 10;
      if (tens > 1) {
        chunkWords.push(twenties[tens]);
        if (unitsDigit > 0) chunkWords.push(ones[unitsDigit]);
      } else if (tens === 1) {
        chunkWords.push(tens[unitsDigit + 1] || tens[1]); // tens[1] is 'Sepuluh'
      } else if (unitsDigit > 0) {
        chunkWords.push(ones[unitsDigit]);
      }
      if (chunkWords.length) {
        words.unshift(chunkWords.join(' ') + ' ' + units[i]);
      }
    }
    num = Math.floor(num / 1000);
    i++;
  }
  return words.join(' ').trim();
}

module.exports = { formatRupiah, numberToWords };
