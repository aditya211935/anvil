using System.Web.Services;

namespace Acme.Catalog.Legacy.Services
{
    [WebService(Namespace = "http://acme.example/orders/archive")]
    public class OrderArchive : WebService
    {
        [WebMethod]
        public OrderSummary GetSummary(int orderId)
        {
            return new OrderSummary { OrderId = orderId };
        }

        [WebMethod(MessageName = "ReleaseHoldV2")]
        public bool ReleaseHold(int orderId, string reason)
        {
            return true;
        }

        public void NotAWebMethod()
        {
        }
    }

    public class OrderSummary
    {
        public int OrderId { get; set; }
        public string Status { get; set; }
    }
}
